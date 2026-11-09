import { homedir } from "node:os";
import { dirname } from "node:path";
import { getAgentDir, ProjectTrustStore, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resourceFingerprint, resourceRoots } from "./lib/resource-state.ts";

export default function (pi: ExtensionAPI, dynamicProvider?: string) {
  let stop: (() => void) | undefined;
  let context: ExtensionContext | undefined;
  let roots = new Set<string>();
  let fingerprint = "";
  let dirty = false;
  let queued = false;
  let scanFailed = false;
  const schedule = () => {
    if (!dirty || queued || !context?.isIdle()) return;
    queued = true;
    pi.sendUserMessage("/t3-reload", { expandPromptTemplates: true });
  };
  pi.registerCommand("t3-reload", {
    description: "Reload skills, instructions, prompts, and extensions in this T3 conversation",
    handler: async (_args, ctx) => {
      queued = false;
      await ctx.waitForIdle();
      await ctx.reload();
    },
  });
  pi.registerCommand("t3-trust", {
    description: "Approve this workspace's project resources through T3",
    handler: async (_args, ctx) => {
      if (ctx.isProjectTrusted()) { ctx.ui.notify("This workspace's project resources are already trusted.", "info"); return; }
      if (process.argv.some(arg => ["--no-approve", "-na"].includes(arg))) {
        ctx.ui.notify("T3's Pi launch arguments explicitly disable project resources with --no-approve. Remove that option in T3 before granting workspace trust.", "warning");
        return;
      }
      if (!ctx.hasUI || !await ctx.ui.confirm("Trust this workspace?", `Allow project skills, settings, MCP servers, prompts, and extensions in ${ctx.cwd}? Project extensions run with your user's permissions.`, { signal: ctx.signal })) return;
      new ProjectTrustStore(getAgentDir()).set(ctx.cwd, true);
      ctx.ui.notify("Workspace trust saved. Restart only this thread's agent through T3 to load its project resources. The T3 conversation can be resumed. Global skill and instruction updates continue to reload automatically.", "info");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    stop?.(); context = ctx;
    roots = new Set(resourceRoots(ctx.cwd, getAgentDir(), homedir()));
    for (const command of pi.getCommands()) if (command.sourceInfo?.path) {
      roots.add(command.sourceInfo.path);
      if (command.source === "skill") roots.add(dirname(dirname(command.sourceInfo.path)));
    }
    for (let index = 0; index < process.argv.length - 1; index++)
      if (process.argv[index] === "--skill") roots.add(process.argv[index + 1]);
    try { fingerprint = resourceFingerprint(roots, dynamicProvider); scanFailed = false; }
    catch { fingerprint = ""; scanFailed = true; }
    dirty = false; queued = false;
    const timer = setInterval(() => {
      try {
        const current = resourceFingerprint(roots, dynamicProvider);
        scanFailed = false;
        if (current !== fingerprint) { fingerprint = current; dirty = true; }
        schedule();
      } catch {
        scanFailed = true;
      }
    }, 1000);
    timer.unref();
    stop = () => { clearInterval(timer); context = undefined; };
  });
  pi.on("before_agent_start", (event, ctx) => {
    for (const file of event.systemPromptOptions?.contextFiles ?? []) roots.add(file.path);
    if (scanFailed) ctx.ui.notify("Some resource paths could not be monitored. Check their permissions or use /t3-reload to retry.", "warning");
  });
  pi.on("agent_settled", schedule);
  pi.on("session_shutdown", () => { stop?.(); });
}
