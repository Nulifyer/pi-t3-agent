import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createModels, createProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverJuicedModels } from "./lib/juiced-catalog.ts";
import { publishCatalog, readCatalog } from "./lib/profile-state.mjs";

export default async function (pi: ExtensionAPI, config: { provider: string; apiKeyEnv?: string; catalogRefreshSeconds?: number }) {
  const directory = getAgentDir();
  const document = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
  const endpoint = document.providers?.[config.provider]?.baseUrl?.replace(/\/+$/, "");
  if (!endpoint) throw new Error("pi-t3-agent: the configured provider has no baseUrl");
  const interval = Math.max(5000, (config.catalogRefreshSeconds ?? 30) * 1000);
  // Pi sets PI_OFFLINE itself when T3 passes --offline. Keep a separate,
  // unambiguous opt-out for this host's metadata requests.
  const network = process.env.PI_T3_OFFLINE === undefined &&
    (process.argv.includes("--offline") || process.env.PI_OFFLINE === undefined);
  let stale = false;
  let lastAttempt = 0;
  let force = false;
  const key = () => {
    const configured = document.providers[config.provider].apiKey ?? "local";
    const reference = typeof configured === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(configured)?.[1] : undefined;
    const value = config.apiKeyEnv ? process.env[config.apiKeyEnv] : reference ? process.env[reference] : process.env[configured] ?? configured;
    if (!value) throw new Error("The configured model API key environment variable is missing.");
    if (typeof value !== "string" || value.startsWith("!")) throw new Error("Juiced discovery requires a literal key or an API key environment variable.");
    return value;
  };
  const restore = (snapshot: any) => snapshot.models.map((model: any) => ({ ...model, provider: config.provider, baseUrl: endpoint }));
  const provider = createProvider({
    id: config.provider, name: config.provider, baseUrl: endpoint, models: [],
    auth: { apiKey: { name: config.provider, resolve: async () => ({ auth: { apiKey: key() } }) } },
    api: openAICompletionsApi(),
    fetchModels: async (context) => {
      const snapshot = readCatalog(directory, config.provider, endpoint);
      const refresh = force; force = false;
      if (!refresh && snapshot && Date.now() - snapshot.fetchedAt < interval) return restore(snapshot);
      if (!network) return snapshot ? restore(snapshot) : [];
      lastAttempt = Date.now();
      try {
        const models = await discoverJuicedModels(endpoint, context.signal, config.provider, { Authorization: `Bearer ${key()}` });
        const published = publishCatalog(directory, config.provider, endpoint, models, lastAttempt);
        stale = false;
        return restore(published);
      } catch (error) {
        stale = true;
        if (snapshot) return restore(snapshot);
        throw error;
      }
    },
  });
  // T3's --offline metadata probe avoids unrelated OAuth refreshes. This
  // bootstrap requests only the operator's configured Juiced metadata.
  const store = new InMemoryModelsStore();
  const bootstrap = createModels({ modelsStore: store });
  bootstrap.setProvider(provider);
  const boot = await bootstrap.refresh({ allowNetwork: true });
  if (boot.errors.size) {
    stale = true;
    console.error("[pi-t3-agent] Juiced discovery is unavailable; check /t3-status in T3.");
  }
  let initial = await store.read(config.provider);
  const refreshProvider = provider.refreshModels!;
  provider.refreshModels = async (context) => {
    if (initial) {
      const snapshot = initial;
      if (await context.publish({ persist: snapshot, update: () => {} })) initial = undefined;
      return;
    }
    await refreshProvider(context);
  };
  pi.registerProvider(provider);

  let cleanup: (() => void) | undefined;
  let refreshing: Promise<void> | undefined;
  const alignSelection = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== config.provider) return;
    const updated = ctx.modelRegistry.find(config.provider, ctx.model.id);
    if (updated && !isDeepStrictEqual(updated, ctx.model)) await pi.setModel(updated);
  };
  const reload = (ctx: ExtensionContext, allowNetwork: boolean) => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await ctx.modelRegistry.refresh({ providers: [config.provider], allowNetwork: network && allowNetwork });
      if (network && allowNetwork) await ctx.modelRegistry.refresh({ providers: [config.provider], allowNetwork: false });
      if (ctx.isIdle()) await alignSelection(ctx);
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  pi.registerCommand("t3-refresh-models", {
    description: "Refresh Juiced models and capabilities without restarting T3",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle(); force = true;
      await reload(ctx, true);
      ctx.ui.notify(stale ? "Juiced is unavailable. The last successful catalog is retained." : "Juiced models refreshed. Refresh T3's provider picker to update its displayed inventory.", stale ? "warning" : "info");
    },
  });
  pi.registerCommand("t3-status", {
    description: "Show Juiced discovery and resource status in T3",
    handler: async (_args, ctx) => {
      const snapshot = readCatalog(directory, config.provider, endpoint);
      const count = ctx.modelRegistry.getAll().filter(model => model.provider === config.provider).length;
      ctx.ui.notify(`Juiced: ${count} models. ${network ? stale ? "Using the last successful catalog." : "Metadata refresh enabled." : "Metadata requests are disabled by the environment."} Last successful refresh: ${snapshot ? new Date(snapshot.fetchedAt).toISOString() : "none"}. Resources reload automatically; /t3-reload refreshes them explicitly.`, stale ? "warning" : "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    cleanup?.();
    const watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (!["models-store.json", "models.json"].includes(String(filename))) return;
      void reload(ctx, false).catch(() => { stale = true; });
    });
    watcher.on("error", () => { stale = true; });
    const timer = setInterval(() => {
      if (ctx.isIdle()) void reload(ctx, true).catch(() => { stale = true; });
    }, interval);
    timer.unref();
    cleanup = () => { clearInterval(timer); watcher.close(); };
    await reload(ctx, false);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (Date.now() - lastAttempt >= interval) await reload(ctx, true);
    await alignSelection(ctx);
    if (ctx.model?.provider === config.provider && !ctx.modelRegistry.find(config.provider, ctx.model.id)) {
      ctx.ui.notify("The selected Juiced model is no longer enabled. Choose an available model in T3. The setup did not switch models.", "error");
      ctx.abort();
    } else if (stale) ctx.ui.notify("Juiced metadata is unavailable. Using the last successful catalog.", "warning");
  });
  pi.on("session_shutdown", () => { cleanup?.(); });
}
