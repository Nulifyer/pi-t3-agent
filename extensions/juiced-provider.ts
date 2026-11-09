import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { createModels, createProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverJuicedModels } from "./lib/juiced-catalog.ts";

export default async function (pi: ExtensionAPI, config: { provider: string; apiKeyEnv?: string }) {
  const models = JSON.parse(await readFile(join(getAgentDir(), "models.json"), "utf8"));
  const endpoint = models.providers?.[config.provider]?.baseUrl;
  if (!endpoint) throw new Error("pi-t3-agent: the configured provider has no baseUrl");
  const apiKey = () => {
    const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : "local";
    if (!key) throw new Error("pi-t3-agent: the configured API key environment variable is missing");
    return key;
  };
  const provider = createProvider({
    id: config.provider,
    name: config.provider,
    baseUrl: endpoint,
    auth: { apiKey: { name: config.provider, resolve: async () => ({ auth: { apiKey: apiKey() } }) } },
    models: [],
    api: openAICompletionsApi(),
    fetchModels: async (context) => discoverJuicedModels(context.baseUrl ?? endpoint, context.signal,
      config.provider, { Authorization: `Bearer ${apiKey()}` }),
  });
  const store = new InMemoryModelsStore();
  const bootstrap = createModels({ modelsStore: store });
  bootstrap.setProvider(provider);
  const result = await bootstrap.refresh({ allowNetwork: process.env.PI_OFFLINE === undefined && !process.argv.includes("--offline") });
  if (result.errors.size) console.error("[pi-t3-agent] Discovery failed; retaining Pi's last successful catalog if available.");
  let initial = await store.read(config.provider);
  const refresh = provider.refreshModels!;
  provider.refreshModels = async (context) => {
    if (initial) {
      const snapshot = initial;
      if (await context.publish({ persist: snapshot, update: () => {} })) initial = undefined;
      return;
    }
    await refresh(context);
  };
  pi.registerProvider(provider);

  let stopWatching: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    stopWatching?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let dirty = false;
    let stopped = false;
    const reload = async () => {
      dirty = true;
      if (refreshing || stopped) return;
      refreshing = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          await ctx.modelRegistry.refresh({ providers: [config.provider], allowNetwork: false });
        }
      } catch {
        console.error("[pi-t3-agent] Could not reload Pi's shared model cache.");
      } finally { refreshing = false; }
    };
    const watcher = watch(getAgentDir(), { persistent: false }, (_kind, filename) => {
      if (!["models-store.json", "models.json"].includes(String(filename))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 50);
      timer.unref();
    });
    watcher.on("error", () => console.error("[pi-t3-agent] Model watcher stopped; reload this Pi session."));
    stopWatching = () => { stopped = true; if (timer) clearTimeout(timer); watcher.close(); };
    await reload();
  });
  pi.on("session_shutdown", async () => stopWatching?.());
}
