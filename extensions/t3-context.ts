import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const tools = new Set(pi.getActiveTools());
    const t3 = (name: string) => tools.has("mcp__t3-code__" + name);
    const guidance = [
      "T3 Code is the user's interface. Pi runs the agent and connects the model host underneath T3. Use T3's supplied tools for threads, other models, delegated work, browser interaction, devices, schedules, secrets, worktrees, and pull requests.",
      "Preserve T3's instructions and permission boundaries. Call the tools directly. Discover missing tools with tool_search. Tool names and availability come from this session, not assumptions about Codex or Claude tools.",
      t3("orchestrator_capabilities") && "For work with another model, first inspect orchestrator_capabilities, then use delegate_task with an available provider, model, and options. Follow its returned next action. Read existing threads with t3_thread_search and t3_thread_read; communicate through t3_thread_send. Creating a new top-level thread is a separate user request. Use task_cancel for a delegated task and t3_thread_wait when instructed. Do not spawn agents with shell commands.",
      t3("preview_status") && "Use T3's shared browser for requested browser work, starting with preview_status. Use the interaction tools actually listed by T3, including preview_act on versions that provide it. Preserve all returned text and image blocks. Use html_preview and html_render for inline visuals, and close tabs you opened through t3_preview_close.",
      tools.has("web_search") && "Use web_search and fetch_content for research when available. Cite actual source URLs and read sources before making claims.",
      "Use command_session for long commands, inspect processExited and exitCode, and stop jobs you no longer need. update_plan saves conversation progress as tool data; it does not switch T3 into Plan mode. ask_user opens questions in T3. Secrets belong in T3's request_secret tool.",
      "Skills and instructions refresh automatically at an idle boundary. /t3-reload refreshes resources explicitly. If project trust is missing, /t3-trust asks for approval in T3 and saves it for this workspace; restart only this thread's agent afterward. Use T3's model picker and provider refresh for model selection. Do not ask the user to operate Pi's terminal interface.",
    ].filter(Boolean).join("\n");
    let shared = "";
    try { if (!process.argv.some(arg => ["--no-context-files", "-nc"].includes(arg))) shared = await readFile(join(homedir(), ".agents", "AGENTS.md"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const sections = event.systemPromptOptions?.sections;
    if (sections && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      sections.pi_t3_setup = guidance;
      if (shared) sections.shared_agent_instructions = shared;
      return;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + guidance + (shared ? "\n\n" + shared : "") };
  });
}
