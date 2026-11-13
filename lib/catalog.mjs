// Model discovery: host metadata -> neutral descriptors -> Pi model definitions.
import { matchesAny } from './config.mjs';

/** Used only when the host reports no context size at all. */
export const FALLBACK_CONTEXT = 32768;

const positive = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

export class DiscoveryError extends Error {
  name = 'DiscoveryError';
}

async function request(baseUrl, path, { headers, signal }) {
  // A redirect could forward the bearer token to another origin.
  const response = await fetch(new URL(path, baseUrl.replace(/\/+$/, '') + '/'), { headers, signal, redirect: 'error' });
  if (response.status === 401 || response.status === 403) {
    throw new DiscoveryError(`The model host rejected the API key (HTTP ${response.status}).`);
  }
  if (!response.ok) return { status: response.status };
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: response.status };
  }
}

/** Juiced 0.9 adds `--parallel 1` itself; a larger value splits the total context between slots. */
export function parallelSlots(llamaArgs) {
  const matches = [...String(llamaArgs ?? '').matchAll(/(?:^|\s)(?:--parallel|-np)(?:\s+|=)(\d+)/g)];
  return positive(Number(matches.at(-1)?.[1])) ?? 1;
}

// Juiced 1.0 states everything a client needs on the catalog entry (discovery schema 1). Juiced 0.9
// derives a `service` name, labels capabilities, and reports a context only for a loaded worker, so
// its unloaded models need the options route. Both are read here.
function juicedSelectable(entry) {
  const contract = entry?.capability_contract;
  const chat = Array.isArray(entry?.operations)
    ? entry.operations.includes('chat/completions')
    : entry?.service === undefined || entry.service === 'Chat';
  return typeof entry?.id === 'string' && entry.id !== '' && chat &&
    entry.downloaded !== false && entry.policy !== 'disabled' && entry.available !== false &&
    contract?.runtime_service !== false &&
    contract?.execution?.compatibility?.compatible !== false &&
    contract?.artifact?.components_complete !== false;
}

/** The per-request switch this client can send: Pi's `qwen-chat-template` thinking format. */
const THINKING_SWITCH = 'chat_template_kwargs.enable_thinking';

function juicedEntry(entry) {
  // Already the tokens one request can use: the host applies llama-server's slot sizing itself.
  const contextWindow = positive(entry.context?.per_request_tokens);
  return {
    contextWindow: contextWindow ?? FALLBACK_CONTEXT,
    ...(contextWindow ? {} : { estimated: true }),
    // A model that thinks without a switch needs nothing from the client and gets no toggle.
    reasoning: entry.thinking?.supported === true && entry.thinking.request_control === THINKING_SWITCH,
    // Pi has no per-model default level, so a host default of off is kept by not offering thinking.
    thinkingOff: entry.thinking?.default === 'off',
    vision: entry.vision === true,
    tools: entry.tool_calls?.supported === true,
  };
}

async function legacyJuicedEntry(baseUrl, entry, options) {
  const labels = Array.isArray(entry.labels) ? entry.labels : [];
  const features = entry.capability_contract?.features ?? {};
  const capabilities = {
    reasoning: labels.includes('reasoning') || features.reasoning === 'declared',
    vision: labels.includes('vision') || features.vision === 'declared',
    tools: labels.includes('tool-calling') || features.tools === 'declared',
  };
  // A loaded worker reports the context of one request slot, which is what a client can use.
  const observed = positive(entry.context?.observed_per_request_tokens) ??
    positive(entry.capability_contract?.limits?.per_request_context_tokens);
  if (observed) return { contextWindow: observed, ...capabilities };
  const detail = await request(baseUrl, `models/${encodeURIComponent(entry.id)}/options`, options).catch((error) => {
    if (options.signal?.aborted) throw error;
    return {};
  });
  const body = detail.body ?? {};
  const total = positive(body.resolved_ctx_size) ?? positive(entry.context?.configured_tokens) ??
    positive(entry.context?.advertised_tokens) ?? positive(entry.context_length) ?? positive(entry.max_context_window);
  if (!total) return { contextWindow: FALLBACK_CONTEXT, estimated: true, ...capabilities };
  // This is a total launch budget that llama.cpp splits between slots. Dividing is the safe reading:
  // an underestimate compacts early, an overestimate overflows the model.
  const slots = entry.recipe === 'llamacpp' ? parallelSlots(body.effective?.llamacpp_args) : 1;
  return { contextWindow: Math.min(Math.floor(total / slots), positive(entry.max_context_window) ?? Infinity), ...capabilities };
}

async function fromJuiced(baseUrl, catalog, options) {
  const selected = catalog.data.filter(juicedSelectable);
  const modern = positive(catalog.discovery_schema_version) !== undefined;
  const descriptors = new Array(selected.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      const entry = selected[index];
      descriptors[index] = {
        id: entry.id,
        ...(modern ? juicedEntry(entry) : await legacyJuicedEntry(baseUrl, entry, options)),
        maxOutput: positive(entry.max_output_tokens) ?? positive(entry.max_completion_tokens),
        hot: entry.policy === 'hot',
      };
    }
  }));
  return descriptors;
}

function fromOpenAi(entries) {
  return entries.filter((entry) => typeof entry?.id === 'string' && entry.id !== '').map((entry) => {
    // llama.cpp, LM Studio and vLLM each name the context size differently.
    const contextWindow = positive(entry.meta?.n_ctx) ?? positive(entry.context_length) ?? positive(entry.context_window) ??
      positive(entry.max_model_len) ?? positive(entry.meta?.n_ctx_train);
    return {
      id: entry.id,
      contextWindow: contextWindow ?? FALLBACK_CONTEXT,
      ...(contextWindow ? {} : { estimated: true }),
      reasoning: false,
      vision: entry.architecture?.input_modalities?.includes('image') === true,
      tools: false,
      hot: false,
    };
  });
}

/**
 * Ask the host which chat models it serves. `mode` is "auto", "juiced" or "openai".
 * Throws when the host is unreachable or answers with nothing usable, so callers keep their last catalog.
 */
export async function discover({ baseUrl, apiKey, mode = 'auto', signal }) {
  const options = { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal };
  if (mode !== 'openai') {
    const catalog = await request(baseUrl, 'juiced/catalog', options);
    if (Array.isArray(catalog.body?.data)) {
      return { source: 'juiced', models: await fromJuiced(baseUrl, catalog.body, options) };
    }
    if (mode === 'juiced') throw new DiscoveryError(`The base URL has no Juiced catalog (HTTP ${catalog.status}).`);
  }
  const list = await request(baseUrl, 'models', options);
  if (!Array.isArray(list.body?.data)) throw new DiscoveryError(`The model host returned no model list (HTTP ${list.status}).`);
  return { source: 'openai', models: fromOpenAi(list.body.data) };
}

/** Pi model definitions for `providers.<id>.models`, in a stable order: always-loaded models first. */
export function toPiModels(descriptors, config) {
  const seen = new Set();
  return descriptors
    .filter((model) => !matchesAny(config.exclude, model.id) && !seen.has(model.id) && seen.add(model.id))
    .sort((a, b) => Number(b.hot) - Number(a.hot) || Number(b.tools) - Number(a.tools) || a.id.localeCompare(b.id))
    .map((model) => {
      // Thinking switched off on the host wins over what the model supports and over a pattern.
      const reasoning = !model.thinkingOff && (model.reasoning || matchesAny(config.reasoning, model.id));
      const vision = model.vision || matchesAny(config.vision, model.id);
      // Leave room for a long file write; a low cap truncates tool-call JSON mid-argument.
      const maxTokens = Math.min(model.maxOutput ?? 32768, Math.max(1024, Math.floor(model.contextWindow / 4)));
      return {
        id: model.id,
        name: model.id,
        reasoning,
        // Local chat templates switch thinking on or off; they have no effort levels.
        ...(reasoning ? { thinkingLevelMap: { off: 'off', minimal: null, low: null, medium: 'medium', high: null, xhigh: null } } : {}),
        input: vision ? ['text', 'image'] : ['text'],
        contextWindow: model.contextWindow,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
          ...(reasoning ? { thinkingFormat: 'qwen-chat-template' } : {}),
        },
      };
    });
}
