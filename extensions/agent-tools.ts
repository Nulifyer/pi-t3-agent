import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CommandSessions } from "./lib/command-sessions.ts";

export default function (pi: ExtensionAPI, shell?: string) {
  const key = Symbol.for("pi-t3-agent.command-runtime");
  const processState = globalThis as typeof globalThis & { [key: symbol]: { commands: CommandSessions; session: string; shell?: string } | undefined };
  let commands = new CommandSessions(shell);
  let plan: { step: string; status: string }[] = [];
  async function restore(event: { reason?: string; type?: string }, ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionId();
    const retained = processState[key];
    if (event.reason === "reload" && retained?.session === session && retained.shell === shell) {
      commands = retained.commands;
    } else {
      await (retained?.commands ?? commands).close();
      commands = new CommandSessions(shell);
    }
    processState[key] = { commands, session, shell };
    plan = [];
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === "pi-t3-agent-plan")
        plan = entry.data.plan;
  }
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") return;
    await commands.close();
    if (processState[key]?.commands === commands) delete processState[key];
  });
  pi.registerTool(
    defineTool({
      name: "command_session",
      label: "Command session",
      description:
        `Run and supervise long commands on this machine using ${shell ?? (process.platform === "win32" ? "powershell" : "bash")}. start returns sessionId immediately; status reads bounded output, input writes literal stdin, stop terminates the process tree, list shows this agent's commands. Commands survive resource reload and end on timeout or session exit/replacement. Plain pipes, not a terminal. Use built-in shell tools for short commands. Never launch agents through this tool; use T3 orchestration.`,
      parameters: Type.Object({
        action: Type.Union(
          ["start", "status", "input", "stop", "list"].map((x) =>
            Type.Literal(x),
          ),
        ),
        command: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        input: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 3600 }),
        ),
        outputOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id, p, signal, _update, ctx) {
        try {
          signal?.throwIfAborted();
          let result;
          if (p.action === "start")
            result = commands.start(
              p.command || "",
              p.cwd || ctx.cwd,
              p.timeoutSeconds,
            );
          else if (p.action === "list") result = commands.list();
          else if (!p.sessionId)
            throw new Error("sessionId is required for " + p.action);
          else if (p.action === "status")
            result = commands.status(p.sessionId, p.outputOffset);
          else if (p.action === "input")
            result = commands.input(p.sessionId, p.input || "");
          else result = await commands.stop(p.sessionId);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: (e as Error).message }],
          };
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "update_plan",
      label: "Task plan",
      description:
        "Read or replace the task plan saved in this Pi conversation. Omit plan to read it. At most one step may be in_progress. This stores task progress, not facts about the user.",
      parameters: Type.Object({
        explanation: Type.Optional(Type.String()),
        plan: Type.Optional(
          Type.Array(
            Type.Object({
              step: Type.String({ minLength: 1 }),
              status: Type.Union([
                Type.Literal("pending"),
                Type.Literal("in_progress"),
                Type.Literal("completed"),
              ]),
            }),
            { maxItems: 20 },
          ),
        ),
      }),
      async execute(_id, p) {
        if (p.plan) {
          if (p.plan.filter((s) => s.status === "in_progress").length > 1)
            return {
              isError: true,
              content: [
                { type: "text", text: "Only one step may be in_progress." },
              ],
            };
          plan = p.plan;
          pi.appendEntry("pi-t3-agent-plan", { plan });
        }
        const result = { plan, explanation: p.explanation };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
  );
}
