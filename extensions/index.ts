import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentTools from "./agent-tools.ts";
import askUser from "./ask-user.ts";
import toolLoadout from "./tool-loadout.ts";
import juicedProvider from "./juiced-provider.ts";

export default async function (pi: ExtensionAPI) {
  const config = JSON.parse(await readFile(join(getAgentDir(), "pi-t3-agent.json"), "utf8"));
  agentTools(pi, config.commandShell);
  askUser(pi);
  toolLoadout(pi, config.provider);
  if (config.discovery === "juiced") await juicedProvider(pi, config);
}
