import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentTools from "./agent-tools.ts";
import askUser from "./ask-user.ts";
import t3Context from "./t3-context.ts";
import resourceReload from "./resource-reload.ts";
import juicedProvider from "./juiced-provider.ts";

export default async function (pi: ExtensionAPI) {
  const config = JSON.parse(await readFile(join(getAgentDir(), "pi-t3-agent.json"), "utf8"));
  agentTools(pi, config.commandShell);
  askUser(pi);
  t3Context(pi);
  resourceReload(pi, config.discovery === "juiced" ? config.provider : undefined);
  if (config.discovery === "juiced") await juicedProvider(pi, config);
  else pi.registerCommand("t3-status", {
    description: "Show the active setup resources in T3",
    handler: async (_args, ctx) => ctx.ui.notify(`${pi.getActiveTools().length} active tools; ${pi.getCommands().filter(command => command.source === "skill").length} loaded skills. Resource reload is automatic. Project resources: ${ctx.isProjectTrusted() ? "trusted" : "not trusted; use /t3-trust"}.`, "info"),
  });
}
