/**
 * Background commands.
 *
 * Pi's shell tool blocks until the command exits, so a dev server or a long build stalls the agent.
 * This wraps the built-in tool with `run_in_background`. Keeping the built-in name means T3 Code still
 * renders the call as a command and applies its approval rules. Execution reuses Pi's own shell
 * backend, which resolves the shell and kills the whole process tree on every platform.
 */
import {
  createBashToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createPowerShellToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MAX_RUNNING = 8;
const MAX_KEPT = 32;
const BUFFER_CHARS = 256 * 1024;
const READ_CHARS = 8000;

type Job = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "exited" | "stopped" | "failed";
  exitCode: number | null;
  output: string;
  /** Characters dropped from the front of `output` once the buffer filled. */
  dropped: number;
  /** Absolute offset the model has read up to. */
  cursor: number;
  abort: AbortController;
  done: Promise<void>;
};

type Registry = { session: string; jobs: Map<string, Job>; next: number };
// Module state is discarded when Pi reloads extensions; running jobs must outlive that.
const REGISTRY = Symbol.for("pi-t3-agent.jobs");
const store = globalThis as typeof globalThis & { [REGISTRY]?: Registry };

const summary = (job: Job) => ({
  id: job.id,
  command: job.command.length > 120 ? job.command.slice(0, 117) + "..." : job.command,
  state: job.state,
  exitCode: job.exitCode,
  seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
});

export default function background(pi: ExtensionAPI, config: { notifyJobExit: boolean }, onJobStart: () => void = () => {}) {
  let registry: Registry = store[REGISTRY] ?? { session: "", jobs: new Map(), next: 1 };

  const stopAll = async (target: Registry) => {
    const running = [...target.jobs.values()].filter((job) => job.state === "running");
    for (const job of running) {
      job.state = "stopped";
      job.abort.abort();
    }
    await Promise.race([Promise.all(running.map((job) => job.done)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  };

  const bind = async (event: { reason?: string }, ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId();
    const kept = store[REGISTRY];
    if (event.reason === "reload" && kept?.session === session) registry = kept;
    else {
      if (kept) await stopAll(kept);
      registry = { session, jobs: new Map(), next: 1 };
    }
    store[REGISTRY] = registry;
  };
  pi.on("session_start", bind);
  pi.on("session_shutdown", async (event: { reason?: string }) => {
    if (event.reason === "reload") return;
    await stopAll(registry);
    if (store[REGISTRY] === registry) delete store[REGISTRY];
  });

  const start = (shell: "bash" | "powershell", command: string, cwd: string, timeout: number | undefined) => {
    const jobs = registry.jobs;
    if ([...jobs.values()].filter((job) => job.state === "running").length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} background jobs are already running. Stop one with background_job first.`);
    }
    for (const old of jobs.values()) {
      if (jobs.size < MAX_KEPT) break;
      if (old.state !== "running") jobs.delete(old.id);
    }
    const owner = registry;
    const job: Job = {
      id: `job-${owner.next++}`, command, cwd, startedAt: Date.now(), state: "running", exitCode: null,
      output: "", dropped: 0, cursor: 0, abort: new AbortController(), done: Promise.resolve(),
    };
    const append = (text: string) => {
      job.output += text;
      if (job.output.length > BUFFER_CHARS) {
        const excess = job.output.length - BUFFER_CHARS;
        job.output = job.output.slice(excess);
        job.dropped += excess;
      }
    };
    const operations = shell === "powershell" ? createLocalPowerShellOperations() : createLocalBashOperations();
    const decoder = new TextDecoder();
    job.done = operations
      .exec(command, cwd, { onData: (data) => append(decoder.decode(data, { stream: true })), signal: job.abort.signal, timeout })
      .then(
        ({ exitCode }) => {
          job.exitCode = exitCode;
          if (job.state === "running") job.state = "exited";
        },
        (error: Error) => {
          if (job.state === "running") {
            job.state = "failed";
            append(`\n[${error.message}]`);
          }
        },
      )
      .then(() => {
        job.endedAt = Date.now();
        // A job the model stopped itself, or one from a session that has ended, needs no notice.
        if (job.state === "stopped" || store[REGISTRY] !== owner || !config.notifyJobExit) return;
        const tail = job.output.slice(-1500).trim();
        pi.sendMessage(
          {
            customType: "pi-t3-agent:job",
            content: `Background job ${job.id} (${summary(job).command}) ${job.state === "failed" ? "failed" : `exited with code ${job.exitCode}`} after ${summary(job).seconds} s.${tail ? `\nLast output:\n${tail}` : ""}`,
            display: true,
            details: summary(job),
          },
          // Idle: start a turn so the agent can react. Busy: deliver once the current work is done.
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });
    jobs.set(job.id, job);
    return job;
  };

  const wrap = (shell: "bash" | "powershell") => {
    const create = shell === "powershell" ? createPowerShellToolDefinition : createBashToolDefinition;
    const builtin = create(process.cwd());
    pi.registerTool({
      ...builtin,
      // Pi enables bash by default and PowerShell only on request; an override must not change that.
      ...(shell === "powershell" ? { defaultActive: false } : {}),
      description: `${builtin.description}\n\nSet run_in_background for a server, watcher or long build. The call returns at once with a job id, you are notified when the job exits, and background_job reads its output or stops it.`,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
        run_in_background: Type.Optional(Type.Boolean({ description: "Start the command and return immediately" })),
      }),
      async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
        const { run_in_background: inBackground, ...foreground } = params;
        if (inBackground !== true) return create(ctx.cwd).execute(toolCallId, foreground, signal, onUpdate, ctx);
        const job = start(shell, params.command, ctx.cwd, params.timeout);
        onJobStart();
        return {
          content: [{ type: "text", text: `Started background job ${job.id}. You will be notified when it exits. Use background_job to read its output or stop it.` }],
          details: { job: summary(job) },
        };
      },
    } as any);
  };
  wrap("bash");
  if (process.platform === "win32") wrap("powershell");

  pi.registerTool({
    name: "background_job",
    label: "Background job",
    description: "Read new output from a background command (optionally waiting for it to exit), stop it, or list this session's jobs.",
    parameters: Type.Object({
      action: StringEnum(["output", "stop", "list"] as const),
      id: Type.Optional(Type.String({ description: "Job id, required for output and stop" })),
      wait_seconds: Type.Optional(Type.Number({ description: "For output: wait up to this long for the job to exit (maximum 120)" })),
    }),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
      const reply = (value: unknown, text: string) => ({ content: [{ type: "text" as const, text }], details: value });
      if (params.action === "list") {
        const jobs = [...registry.jobs.values()].map(summary);
        return reply({ jobs }, jobs.length ? jobs.map((job) => `${job.id} ${job.state}${job.exitCode === null ? "" : ` (${job.exitCode})`} ${job.seconds}s  ${job.command}`).join("\n") : "No background jobs.");
      }
      const job = registry.jobs.get(params.id ?? "");
      if (!job) throw new Error(`Unknown background job: ${params.id ?? "(no id given)"}`);
      if (params.action === "stop") {
        if (job.state === "running") {
          job.state = "stopped";
          job.abort.abort();
          await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
        }
      } else if (job.state === "running" && params.wait_seconds > 0) {
        const wait = Math.min(params.wait_seconds, 120) * 1000;
        await Promise.race([
          job.done,
          new Promise((resolve) => setTimeout(resolve, wait)),
          new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
        ]);
      }
      // Return only what the model has not seen, newest part first to go when it does not fit.
      const available = job.dropped + job.output.length;
      const from = Math.max(job.cursor, job.dropped, available - READ_CHARS);
      const text = job.output.slice(from - job.dropped);
      const skipped = from - job.cursor;
      job.cursor = available;
      const state = summary(job);
      const header = `${job.id} ${state.state}${state.exitCode === null ? "" : `, exit code ${state.exitCode}`}, ${state.seconds} s.`;
      return reply({ job: state, skippedChars: skipped }, `${header}${skipped > 0 ? `\n[${skipped} earlier characters omitted]` : ""}\n${text || "(no new output)"}`);
    },
  } as any);

  return { describe: () => `${[...registry.jobs.values()].filter((job) => job.state === "running").length} background jobs running` };
}
