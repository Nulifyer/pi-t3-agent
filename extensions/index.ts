/**
 * pi-t3-agent: makes a self-hosted model host usable through Pi inside T3 Code.
 *
 * Each module covers one gap between what T3 Code's Pi adapter does and what a local model needs.
 * T3 Code owns the UI, permissions, MCP bridge and threads; nothing here replaces those.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, loadConfig } from "../lib/config.mjs";
import ask from "./ask.ts";
import background from "./background.ts";
import catalog from "./catalog.ts";
import reload from "./reload.ts";
import toolshelf from "./toolshelf.ts";

export default async function (pi: ExtensionAPI) {
  const directory = getAgentDir();
  // Without setup there is no host to sync, but the tools still work.
  const config = loadConfig(directory) ?? DEFAULTS;
  const shelf = toolshelf(pi, config);
  // In the compact loadout the job tool is shelved until there is a job to manage.
  const jobs = background(pi, config, () => shelf.load(["background_job"]));
  ask(pi);
  const parts = [await catalog(pi, directory), shelf, jobs, reload(pi)];

  pi.registerCommand("pi-status", {
    description: "Show model sync, tool loadout and background job status for this thread",
    handler: async (_args, ctx) => {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${ctx.model.contextWindow} token context)` : "no model selected";
      const trust = ctx.isProjectTrusted() ? "workspace trusted" : "workspace not trusted, /pi-trust to change";
      ctx.ui.notify([model, ...parts.map((part) => part.describe()), trust].join("\n"), "info");
    },
  });
}
