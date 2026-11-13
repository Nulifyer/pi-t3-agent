/**
 * Resource reload and project trust.
 *
 * A T3 Code thread keeps its Pi process, so a skill or instruction file edited later is not seen
 * until the session restarts. T3's skill picker reads fresh copies, which means a newly added skill
 * can be picked there and then silently not expand in an older thread. This watches the resource
 * locations and runs Pi's own reload while the agent is idle. No model request is made.
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, ProjectTrustStore, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"]);

type Target = { watcher?: FSWatcher; accepts: ((file: string) => boolean)[] };
// Watchers are down while Pi reloads. The time a reload began is kept outside the module, which is
// re-created by the reload, so the new instance can look for edits made in that gap.
const RELOAD = Symbol.for("pi-t3-agent.reload-started");
const store = globalThis as typeof globalThis & { [RELOAD]?: number };
const IGNORED = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

export default function reload(pi: ExtensionAPI) {
  /** One watcher per path and mode; several interests in the same path share it. */
  const targets = new Map<string, Target>();
  const contextFiles = new Set<string>();
  let context: ExtensionContext | undefined;
  let dirty = false;
  let queued = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let unwatched = 0;

  const dispatch = () => {
    if (!dirty || queued || !context?.isIdle()) return;
    queued = true;
    dirty = false;
    // A leading slash with expandPromptTemplates runs the command; nothing reaches the model.
    pi.sendUserMessage("/pi-reload", { expandPromptTemplates: true });
  };
  const changed = () => {
    dirty = true;
    clearTimeout(debounce);
    debounce = setTimeout(dispatch, 500);
  };
  const close = () => {
    clearTimeout(debounce);
    for (const target of targets.values()) target.watcher?.close();
    targets.clear();
    contextFiles.clear();
  };
  const add = (path: string, recursive: boolean, accept: (file: string) => boolean) => {
    const key = `${recursive ? "tree" : "dir"}:${path}`;
    const existing = targets.get(key);
    if (existing) return void existing.accepts.push(accept);
    if (!existsSync(path)) return;
    const target: Target = { accepts: [accept] };
    try {
      target.watcher = watch(path, { persistent: false, recursive }, (_change, file) => {
        const name = String(file ?? "");
        // Version control, dependencies and editor temporaries are never resources.
        if (IGNORED.test(name) || name.endsWith("~") || name.endsWith(".tmp")) return;
        if (target.accepts.some((accepts) => accepts(name))) changed();
      });
      target.watcher.on("error", () => undefined);
      targets.set(key, target);
    } catch {
      unwatched++;
    }
  };
  /** Whether anything watched was written at or after `since`. One scan per reload, not a poll. */
  const changedSince = (since: number) => {
    const newer = (path: string, depth: number): boolean => {
      let stat;
      try { stat = statSync(path); } catch { return false; }
      // A directory's own time moves when an entry is added or removed.
      if (stat.mtimeMs >= since) return true;
      if (!stat.isDirectory() || depth >= 8) return false;
      return readdirSync(path).some((name) => !IGNORED.test(name) && newer(join(path, name), depth + 1));
    };
    for (const [key, target] of targets) {
      const path = key.slice(key.indexOf(":") + 1);
      if (key.startsWith("tree:")) {
        if (newer(path, 0)) return true;
        continue;
      }
      try {
        if (readdirSync(path).some((name) => target.accepts.some((accepts) => accepts(name)) && statSync(join(path, name)).mtimeMs >= since)) return true;
      } catch { /* The directory went away; its parent's watcher reports that. */ }
    }
    return false;
  };
  /** Watch a resource directory, and its parent so that creating the directory is noticed too. */
  const addResources = (parent: string, names: string[]) => {
    add(parent, false, (file) => names.includes(file));
    for (const name of names) add(join(parent, name), true, () => true);
  };

  pi.on("session_start", (event: { reason?: string }, ctx) => {
    close();
    context = ctx;
    dirty = queued = false;
    unwatched = 0;
    const agent = getAgentDir();
    // The places Pi reads skills and prompt templates from.
    addResources(agent, ["skills", "prompts"]);
    addResources(join(homedir(), ".agents"), ["skills"]);
    addResources(join(ctx.cwd, ".pi"), ["skills", "prompts"]);
    addResources(join(ctx.cwd, ".agents"), ["skills"]);
    // Skills and prompts loaded from anywhere else, such as packages or --skill.
    for (const command of pi.getCommands()) {
      const path = command.sourceInfo?.path;
      if (typeof path !== "string" || !existsSync(path)) continue;
      if (command.source === "skill") add(dirname(dirname(path)), true, () => true);
      else if (command.source === "prompt") add(dirname(path), true, () => true);
    }
    for (const directory of [agent, ctx.cwd]) add(directory, false, (file) => CONTEXT_FILES.has(file));
    const reloadStarted = store[RELOAD];
    delete store[RELOAD];
    if (event.reason === "reload" && reloadStarted !== undefined && changedSince(reloadStarted)) changed();
  });
  pi.on("before_agent_start", (event: any) => {
    // Context files further up the tree are only known once Pi has loaded them.
    for (const file of event.systemPromptOptions?.contextFiles ?? []) {
      if (typeof file?.path !== "string" || contextFiles.has(file.path)) continue;
      contextFiles.add(file.path);
      const name = file.path.split(/[\\/]/).at(-1);
      add(dirname(file.path), false, (changedFile) => changedFile === name);
    }
  });
  pi.on("agent_settled", dispatch);
  pi.on("session_shutdown", () => {
    close();
    context = undefined;
  });

  pi.registerCommand("pi-reload", {
    description: "Reload skills, prompts, instruction files and extensions in this thread",
    handler: async (_args, ctx) => {
      queued = false;
      await ctx.waitForIdle();
      store[RELOAD] = Date.now();
      await ctx.reload();
    },
  });

  pi.registerCommand("pi-trust", {
    description: "Trust this workspace so Pi loads its project skills, settings and extensions",
    handler: async (_args, ctx) => {
      if (ctx.isProjectTrusted()) return ctx.ui.notify("This workspace is already trusted.", "info");
      if (process.argv.some((arg) => arg === "--no-approve" || arg === "-na")) {
        return ctx.ui.notify("Pi was started with --no-approve, which keeps project resources off. Remove it from the Pi launch arguments in T3 Code settings first.", "warning");
      }
      const approved = await ctx.ui.confirm(
        "Trust this workspace?",
        `Pi will load project skills, prompts, settings, MCP servers and extensions from ${ctx.cwd}. Project extensions run with your permissions.`,
        { signal: ctx.signal },
      );
      if (!approved) return;
      new ProjectTrustStore(getAgentDir()).set(ctx.cwd, true);
      // Pi decides trust once per process, so the running session cannot pick it up.
      ctx.ui.notify("Trust saved. It applies when this thread's Pi session restarts: start a new thread here, or switch the permission mode and back.", "info");
    },
  });

  return { describe: () => (unwatched > 0 ? `resource reload is automatic except for ${unwatched} location${unwatched === 1 ? "" : "s"} that could not be watched` : "resource reload is automatic") };
}
