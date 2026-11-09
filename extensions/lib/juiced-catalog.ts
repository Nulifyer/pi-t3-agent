/** Juiced v0.6 serving metadata -> Pi chat models, without loading any weights. */
import type { Model } from "@earendil-works/pi-ai";
type RecordValue = Record<string, any>;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function parallelFromArgs(args: string): number {
  const values = [...args.matchAll(/(?:^|\s)(?:--parallel|-np)(?:\s+|=)(\S+)/g)];
  // Juiced's llama.cpp recipe supplies --parallel 1 unless explicitly overridden.
  if (!values.length) return 1;
  const count = Number(values.at(-1)![1]);
  if (!positive(count)) throw new Error("Juiced has an unresolved parallel slot count");
  return count;
}

export async function discoverJuicedModels(baseUrl: string, parentSignal: AbortSignal, provider = "local", headers: Record<string, string> = {}): Promise<Model<"openai-completions">[]> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]);
  const root = baseUrl.replace(/\/+$/, "") + "/";
  async function get(path: string): Promise<RecordValue> {
    const response = await fetch(new URL(path, root), { signal, headers, redirect: "error" });
    if (!response.ok) throw new Error(`Juiced discovery ${path.split("/")[0]}: HTTP ${response.status}`);
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Juiced discovery response");
    return value as RecordValue;
  }
  const [catalog, health] = await Promise.all([get("juiced/catalog"), get("health")]);
  if (!Array.isArray(catalog.data) || !Array.isArray(health.all_models_loaded)) {
    throw new Error("Juiced discovery response has no catalog/worker list");
  }
  const selected = catalog.data.filter((m: RecordValue) => m.service === "Chat" &&
    ["hot", "on-demand"].includes(m.policy) && m.downloaded === true);
  const ids = new Set<string>();
  for (const model of selected) {
    if (typeof model.id !== "string" || !model.id || ids.has(model.id)) throw new Error("Invalid/duplicate Juiced model ID");
    ids.add(model.id);
  }
  // Bound concurrent metadata reads even with many enabled models. One five-second
  // deadline covers the complete snapshot; Pi retains its native cache on failure.
  const results: Model<"openai-completions">[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) {
      const model = selected[cursor++];
      const options = await get(`models/${encodeURIComponent(model.id)}/options`);
      const worker = health.all_models_loaded.find((m: RecordValue) => m.model_name === model.id && m.loaded);
      const effective = worker?.recipe_options ?? options.effective;
      if (!effective || typeof effective !== "object") throw new Error("Juiced has no effective model options");
      let total = worker ? effective.ctx_size : options.resolved_ctx_size;
      if (!positive(total)) throw new Error("Juiced has no resolved serving context");
      const args = String(effective.llamacpp_args ?? "");
      const parallel = model.recipe === "llamacpp" ? parallelFromArgs(args) : 1;
      const capacity = Math.floor(total / parallel);
      const architecture = model.max_context_window;
      const contextWindow = Math.min(capacity, positive(architecture) ? architecture : capacity, 65536);
      if (contextWindow < 512) throw new Error("Juiced serving context is too small for Pi");
      const labels = Array.isArray(model.labels) ? model.labels : [];
      const reasoning = labels.some((label: string) => ["reasoning", "thinking"].includes(label)) &&
        !/(?:^|\s)--reasoning(?:\s+|=)off(?:\s|$)/.test(args);
      results.push({
        id: model.id, name: model.id, provider, api: "openai-completions",
        baseUrl: baseUrl.replace(/\/+$/, ""),
        reasoning, input: labels.includes("vision") ? ["text", "image"] : ["text"],
        contextWindow, maxTokens: Math.min(8192, Math.floor(contextWindow / 2)),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
      });
    }
  }));
  // Stable default order: Hot before On-demand, then the exact registered name.
  const policies = new Map(selected.map((m: RecordValue) => [m.id, m.policy]));
  return results.sort((a, b) => Number(policies.get(a.id) !== "hot") - Number(policies.get(b.id) !== "hot") || a.id.localeCompare(b.id));
}
