/**
 * Tool loadout budget.
 *
 * T3 Code declares its whole MCP catalog (about 70 schemas, roughly 14,000 tokens) on every request to
 * an `openai-completions` model. That floor exceeds a small local model's context and is re-evaluated
 * by the model host whenever its prompt cache is cold. Pi's built-in `tool_search` cannot help: it
 * only searches inactive tools, and T3 has activated all of them.
 *
 * This module keeps those tools active and callable but leaves their declarations out of requests
 * ("shelved") until the model asks for them through `tool_search`. It uses Pi's `prepareLoadout`
 * hook, so T3's bridge still sees every tool as active and does not re-add anything.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rankTools } from "../lib/rank.mjs";

const T3_PREFIX = "mcp__t3-code__";
/** T3 keeps these three declared for every other model API; do the same here. */
const T3_DIRECT = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
/** Declared even for small-context models. */
const CORE = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "tool_search", "ask_user"]);
const SHELF = "tool_shelf";
const ENTRY = "pi-t3-agent:tools-loaded";

export default function toolshelf(pi: ExtensionAPI, config: { compactBelow: number }) {
  /** Shelved tools the model has asked for or already used on this session branch. */
  const loaded = new Set<string>();
  let compact = false;

  const isShelved = (name: string) => {
    if (name === SHELF) return true;
    if (loaded.has(name)) return false;
    if (name.startsWith(T3_PREFIX)) return compact || !T3_DIRECT.has(name.slice(T3_PREFIX.length));
    return compact && !CORE.has(name);
  };
  const shelvedTools = () => {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools().filter((tool) => tool.name !== SHELF && active.has(tool.name) && isShelved(tool.name));
  };
  /** Pi runs `prepareLoadout` whenever the active set is applied, including with the same names. */
  const recompute = () => pi.setActiveTools(pi.getActiveTools());
  const load = (names: string[]) => {
    const added = names.filter((name) => !loaded.has(name));
    if (added.length === 0) return;
    for (const name of added) loaded.add(name);
    // Saved on the branch so the same declarations return after resume, fork and tree navigation.
    pi.appendEntry(ENTRY, { names: added });
    recompute();
  };
  const isCompact = (model: { contextWindow?: number } | undefined) =>
    typeof model?.contextWindow === "number" && model.contextWindow < config.compactBelow;

  // The hook must belong to an active tool. This one exists only to carry it and hides itself.
  pi.registerTool({
    name: SHELF,
    label: "Tool shelf",
    description: "Internal. Use tool_search to load tools.",
    parameters: Type.Object({}),
    prepareLoadout: (loadout) => ({ hiddenDeclarations: loadout.declared.map((tool) => tool.name).filter(isShelved) }),
    async execute() {
      return { content: [{ type: "text", text: "Use tool_search to load tools." }], details: {}, isError: true };
    },
  });

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    loaded.clear();
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      if (entry.type === "custom" && entry.customType === ENTRY) for (const name of entry.data?.names ?? []) loaded.add(name);
      // A tool named in history must stay declared, or the host may reject the replayed call.
      if (entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) if (block?.type === "toolCall" && typeof block.name === "string") loaded.add(block.name);
      }
    }
    compact = isCompact(ctx.model);
    recompute();
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", (event: any, ctx) => {
    const next = isCompact(event.model ?? ctx.model);
    if (next === compact) return;
    compact = next;
    recompute();
  });

  // A shelved tool is still callable. Once the model calls one, declare it from then on.
  pi.on("tool_call", (event) => {
    if (event.toolName !== SHELF && isShelved(event.toolName)) load([event.toolName]);
  });

  pi.on("tool_result", (event: any) => {
    if (event.toolName !== "tool_search" || event.isError) return;
    const query = typeof event.input?.query === "string" ? event.input.query : "";
    const limit = Number.isInteger(event.input?.limit) && event.input.limit > 0 ? event.input.limit : compact ? 4 : 6;
    const matches = rankTools(query, shelvedTools(), limit);
    if (matches.length === 0) return;
    load(matches.map((tool) => tool.name));
    const builtin: string[] = Array.isArray(event.details?.loaded) ? event.details.loaded : [];
    const lines = matches.map((tool) => `- ${tool.name}: ${(tool.description ?? "").trim().split(/\r?\n/)[0].slice(0, 160)}`);
    const existing = builtin.length > 0
      ? (event.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text.split(/\r?\n/).slice(1).join("\n")).filter(Boolean)
      : [];
    const total = builtin.length + matches.length;
    return {
      content: [{ type: "text", text: `Loaded ${total} tool${total === 1 ? "" : "s"}. They are available from your next call:\n${[...existing, ...lines].join("\n")}` }],
      details: { loaded: [...builtin, ...matches.map((tool) => tool.name)] },
    };
  });

  pi.on("before_agent_start", (event: any, ctx) => {
    const options = event.systemPromptOptions;
    const sections = options?.sections;
    // An exact custom prompt bypasses section rendering; the shelf still works without the hint.
    if (!sections || typeof sections !== "object" || options.forceSystemPrompt !== undefined) return;
    const shelved = shelvedTools();
    if (shelved.length === 0) {
      delete sections.tool_loading;
      return;
    }
    const t3 = shelved.some((tool) => tool.name.startsWith(T3_PREFIX));
    sections.tool_loading = [
      `${shelved.length} more tools are installed but not listed, to save context. Call tool_search with a few words for what you need (for example "thread read" or "browser preview"); the matches are loaded for your next call.`,
      t3 ? "This covers the T3 Code tools for threads, browser preview, devices, schedules, pull requests, worktrees, environments and secrets." : "",
      compact && Array.isArray(options.skills) && options.skills.length > 0 ? "Skills are not listed for this small-context model. The user can attach one with $name." : "",
    ].filter(Boolean).join(" ");
    // Skill descriptions are the largest prompt section. T3 still expands a skill the user picks.
    if (compact && Array.isArray(options.skills)) options.skills.length = 0;
  });

  return {
    /** Declare tools another module now needs, if the budget had shelved them. */
    load: (names: string[]) => load(names.filter(isShelved)),
    describe: () => {
      const active = pi.getActiveTools().filter((name) => name !== SHELF);
      const shelved = shelvedTools().length;
      return `${active.length - shelved} tools declared, ${shelved} on demand${compact ? " (compact loadout for this model's context)" : ""}`;
    },
  };
}
