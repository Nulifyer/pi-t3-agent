import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Job = {
  id: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  state: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  dropped: number;
  logBytes: number;
  logPath: string;
  logError?: string;
  closed: boolean;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  termination?: Promise<void>;
};

export function shellCommand(command: string, shell: string, platform = process.platform) {
  if (shell === "powershell") {
    if (platform !== "win32") throw new Error("PowerShell command sessions require Windows");
    const script = "$ErrorActionPreference = 'Stop'; & {\n" + command +
      "\n}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
    return { binary: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (shell !== "bash") throw new Error("Unknown command shell");
  const candidates = platform === "win32" ? [
    process.env.PI_T3_BASH_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe"),
  ].filter((value): value is string => !!value) : [];
  const binary = candidates.find((path) => existsSync(path)) ?? (platform === "win32" ? "bash.exe" : "/bin/bash");
  return { binary, args: ["-lc", command] };
}

export class CommandSessions {
  private jobs = new Map<string, Job>();
  private directory?: string;
  private shell: string;

  constructor(shell = process.platform === "win32" ? "powershell" : "bash") { this.shell = shell; }

  start(command: string, cwd: string, timeoutSeconds = 600) {
    if (!command.trim()) throw new Error("A command is required.");
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 3600
    )
      throw new Error("timeoutSeconds must be an integer from 1 to 3600.");
    if (
      [...this.jobs.values()].filter((j) => !j.closed).length >= 4
    )
      throw new Error(
        "Four commands are running. Stop one before starting another.",
      );
    if (this.jobs.size >= 32) {
      const oldest = [...this.jobs.values()].find(job => job.closed);
      if (oldest) {
        this.jobs.delete(oldest.id);
        rmSync(oldest.logPath, { force: true });
      }
    }
    this.directory ??= mkdtempSync(join(tmpdir(), "pi-commands-"));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID().slice(0, 12);
    const invocation = shellCommand(command, this.shell);
    const child = spawn(invocation.binary, invocation.args, {
      cwd: resolve(cwd),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const job: Job = {
      id,
      child,
      command,
      cwd: resolve(cwd),
      state: "running",
      exitCode: null,
      signal: null,
      output: "",
      dropped: 0,
      logBytes: 0,
      closed: false,
      logPath: join(this.directory, id + ".log"),
      started: Date.now(),
    };
    this.jobs.set(id, job);
    const collect = (chunk: string) => {
      if (!job.logError && job.logBytes < 8 * 1024 * 1024) {
        const bytes = Buffer.from(chunk).subarray(
          0,
          8 * 1024 * 1024 - job.logBytes,
        );
        try {
          appendFileSync(job.logPath, bytes, { mode: 0o600 });
          job.logBytes += bytes.length;
        } catch (error) {
          job.logError = (error as Error).message;
        }
      }
      job.output += chunk;
      if (job.output.length > 65536) {
        const excess = job.output.length - 65536;
        job.dropped += excess;
        job.output = job.output.slice(excess);
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.stdin!.on("error", () => {});
    child.on("error", (error) => {
      collect(error.message);
      job.state = "failed";
      clearTimeout(job.timer);
    });
    child.on("close", (code, signal) => {
      clearTimeout(job.timer);
      job.exitCode = code;
      job.signal = signal;
      job.closed = true;
      if (job.state === "running")
        job.state = code === 0 ? "completed" : "failed";
    });
    job.timer = setTimeout(
      () => this.terminate(job, "timed-out"),
      timeoutSeconds * 1000,
    );
    job.timer.unref();
    return this.status(id);
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown command session: " + id);
    return job;
  }

  status(id: string, offset?: number) {
    const j = this.get(id);
    const requested =
      offset ?? Math.max(j.dropped, j.dropped + j.output.length - 8000);
    if (!Number.isInteger(requested) || requested < 0)
      throw new Error("outputOffset must be a nonnegative integer.");
    const start = Math.max(0, requested - j.dropped);
    const output = j.output.slice(start, start + 8000);
    return {
      sessionId: id,
      status: j.state,
      pid: j.child.pid ?? null,
      exitCode: j.exitCode,
      signal: j.signal,
      runtimeSeconds: Math.round((Date.now() - j.started) / 1000),
      processExited: j.closed,
      output,
      outputOffset: j.dropped + start,
      nextOffset: j.dropped + start + output.length,
      outputTruncated: requested < j.dropped,
      logPath: j.logPath,
      logCapped: j.logBytes >= 8 * 1024 * 1024,
      logError: j.logError,
    };
  }

  input(id: string, input: string) {
    const j = this.get(id);
    if (j.state !== "running" || j.child.stdin?.destroyed)
      throw new Error("Command is not accepting input.");
    j.child.stdin!.write(input);
    return this.status(id);
  }

  private terminate(j: Job, reason: string) {
    if (j.termination) return j.termination;
    if (j.state !== "running") return Promise.resolve();
    j.state = reason;
    clearTimeout(j.timer);
    j.termination = (async () => {
      if (!j.child.pid) return;
      if (process.platform === "win32") {
        await new Promise<void>((done) => {
          const killer = spawn("taskkill.exe", ["/PID", String(j.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", (error) => { j.logError = "Cancellation failed: " + error.message; done(); });
          killer.once("close", (code) => {
            if (code !== 0 && !j.closed) j.logError = "taskkill did not confirm process-tree termination";
            done();
          });
        });
      } else {
        const signal = (name: NodeJS.Signals) => {
          try { process.kill(-j.child.pid!, name); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") j.logError = "Cancellation failed: " + (error as Error).message;
          }
        };
        signal("SIGTERM");
        await new Promise((done) => setTimeout(done, 1000));
        // A descendant may outlive the shell, so kill the remaining group too.
        signal("SIGKILL");
      }
      const deadline = Date.now() + 5000;
      while (!j.closed && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      if (!j.closed) j.logError = "Cancellation did not confirm process exit";
    })();
    return j.termination;
  }

  async stop(id: string) {
    const j = this.get(id);
    await this.terminate(j, "stopped");
    return this.status(id);
  }

  list() {
    return [...this.jobs.keys()].map((id) => this.status(id));
  }
  async close() {
    await Promise.all([...this.jobs.values()].map((j) => this.terminate(j, "stopped")));
  }
}
