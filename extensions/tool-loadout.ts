import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI, provider?: string) {
  const everyday = new Set([
    "read",
    "bash",
    "powershell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "tool_search",
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
    "command_session",
    "update_plan",
    "ask_user",
    ...[
      "preview_status",
      "preview_open",
      "preview_navigate",
      "preview_snapshot",
      "preview_click",
      "preview_type",
      "preview_press",
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
    ].map((name) => "mcp__t3-code__" + name),
  ]);
  const discovered = new Set<string>();
  pi.on("tool_result", (event) => {
    if (event.toolName === "tool_search")
      for (const name of pi.getActiveTools())
        if (name.startsWith("mcp__t3-code__")) discovered.add(name);
  });
  // T3's Chat Completions compatibility hook eagerly activates deferred MCP
  // schemas. Apply our loadout after discovery, without unregistering tools.
  pi.on("before_agent_start", (event, ctx) => {
    if (
      (provider !== undefined && ctx.model?.provider !== provider) ||
      ctx.model?.api !== "openai-completions"
    )
      return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant")
        continue;
      for (const block of entry.message.content)
        if (
          block.type === "toolCall" &&
          block.name.startsWith("mcp__t3-code__")
        )
          discovered.add(block.name);
    }
    pi.setActiveTools(
      pi
        .getAllTools()
        .filter(
          (tool) =>
            tool.exposure !== "hidden" &&
            (everyday.has(tool.name) || discovered.has(tool.name)),
        )
        .map((tool) => tool.name),
    );
    const guidance = [
      "Call everyday tools directly. No JavaScript wrapper or codemode is needed. Use tool_search to discover additional T3 tools, then call the returned tool name directly.",
      "Use web_search for research, fetch_content to read sources and get_search_content for bounded passages. Cite the actual source URLs. Search snippets alone are not full source verification.",
      "Use T3's shared browser for interactive pages. Start with preview_status and open a tab if needed. Read the full returned text and image blocks; do not discard content after the first block.",
      "Use command_session for long builds/tests and inspect exitCode before claiming success. Use update_plan for substantial tasks. Do not use command_session to spawn agents; T3 owns orchestration.",
      "Call ask_user directly when a clarification or preference is needed. It opens a structured question in T3.",
    ].join("\n");
    // T3 supplies a forced prompt, so preserve it and append our guidance.
    return { systemPrompt: event.systemPrompt + "\n\n" + guidance };
  });
}
