import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { discover, FALLBACK_CONTEXT, parallelSlots, toPiModels } from '../lib/catalog.mjs';
import { DEFAULTS, matchesAny } from '../lib/config.mjs';
import { rankTools } from '../lib/rank.mjs';

/** Serve a route table; a missing route answers 404 like a host without that API. */
async function host(t, routes) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    const route = routes[request.url];
    if (!route) return void response.writeHead(404).end('{}');
    response.writeHead(route.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(route.body ?? route));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen };
}
const signal = () => AbortSignal.timeout(5000);
const chat = (id, extra = {}) => ({ id, service: 'Chat', policy: 'on-demand', downloaded: true, recipe: 'llamacpp', labels: ['chat'], ...extra });

test('Juiced 0.9: per-slot context comes from the loaded worker, else from resolved options', async (t) => {
  const h = await host(t, {
    '/v1/juiced/catalog': { data: [
      chat('loaded', { policy: 'hot', context: { observed_per_request_tokens: 40960 }, max_context_window: 262144, labels: ['chat', 'tool-calling', 'reasoning', 'vision'] }),
      chat('auto', { context: { configured_tokens: null, configured_automatic: true }, max_context_window: 131072 }),
      chat('two-slots', { context: { configured_tokens: 32768 } }),
      chat('capped', { context: { configured_tokens: 65536 }, max_context_window: 8192 }),
      chat('no-options', { context: { advertised_tokens: 16384 }, capability_contract: { features: { reasoning: 'declared' } } }),
      chat('unknown'),
    ] },
    '/v1/models/auto/options': { resolved_ctx_size: 24576, effective: { llamacpp_args: '--parallel 1 --jinja' } },
    '/v1/models/two-slots/options': { resolved_ctx_size: -1, effective: { llamacpp_args: '-np 2' } },
    '/v1/models/capped/options': { resolved_ctx_size: 65536, effective: {} },
  });
  const found = await discover({ baseUrl: h.baseUrl, apiKey: 'secret', signal: signal() });
  assert.equal(found.source, 'juiced');
  const byId = Object.fromEntries(found.models.map((model) => [model.id, model]));
  assert.equal(byId.loaded.contextWindow, 40960, 'observed slot context, not the trained maximum');
  assert.deepEqual([byId.loaded.reasoning, byId.loaded.vision, byId.loaded.tools, byId.loaded.hot], [true, true, true, true]);
  assert.equal(byId.auto.contextWindow, 24576, 'automatic sizing is resolved by the host');
  assert.equal(byId['two-slots'].contextWindow, 16384, 'the total is split between parallel slots');
  assert.equal(byId.capped.contextWindow, 8192);
  assert.equal(byId['no-options'].contextWindow, 16384);
  assert.equal(byId['no-options'].reasoning, true);
  assert.deepEqual([byId.unknown.contextWindow, byId.unknown.estimated], [FALLBACK_CONTEXT, true]);
  assert.ok(h.seen.every((request) => request.authorization === 'Bearer secret'));
  assert.ok(!h.seen.some((request) => request.url === '/v1/models/loaded/options'), 'a loaded model needs no second request');
});

test('Juiced 1.0: the catalog entry states context, thinking, images and tools; nothing else is requested', async (t) => {
  const SWITCH = 'chat_template_kwargs.enable_thinking';
  const entry = (id, extra = {}) => ({
    id, operations: ['chat/completions', 'completions', 'responses'], policy: 'on-demand', downloaded: true, loaded: false,
    context: { per_request_tokens: 32768, per_request_source: 'configured' }, vision: false,
    thinking: { supported: false, source: 'gguf_chat_template' }, tool_calls: { supported: true, source: 'gguf_chat_template' }, ...extra,
  });
  const thinking = (extra = {}) => ({ thinking: { supported: true, request_control: SWITCH, default: 'on', ...extra } });
  const h = await host(t, {
    '/v1/juiced/catalog': { schema_version: 1, discovery_schema_version: 1, revision: 'r1', data: [
      entry('coder', { policy: 'hot', loaded: true, vision: true, ...thinking(), max_output_tokens: 4096,
        // Two slots share a 131072 launch total. The host has already worked out one request's share.
        context: { per_request_tokens: 65536, per_request_source: 'observed', configured_tokens: 131072, configured_slots: 2 } }),
      entry('quiet', thinking({ default: 'off' })),
      entry('always-thinks', thinking({ request_control: null })),
      entry('effort', thinking({ request_control: 'reasoning_effort' })),
      entry('no-tools', { tool_calls: { supported: false } }),
      entry('unsized', { context: { per_request_tokens: null, per_request_source: null, configured_tokens: 8192 }, thinking: { supported: null, reason: 'chat_template_unavailable' } }),
      entry('speech', { operations: ['audio/speech'], policy: 'hot' }),
      entry('images', { operations: ['images/generations'] }),
      entry('off', { policy: 'disabled' }),
      entry('missing', { downloaded: false }),
    ] },
  });
  const found = await discover({ baseUrl: h.baseUrl, signal: signal() });
  const byId = Object.fromEntries(found.models.map((model) => [model.id, model]));
  assert.deepEqual(Object.keys(byId), ['coder', 'quiet', 'always-thinks', 'effort', 'no-tools', 'unsized']);
  assert.deepEqual(byId.coder, { id: 'coder', contextWindow: 65536, reasoning: true, thinkingOff: false, vision: true, tools: true, maxOutput: 4096, hot: true });
  assert.deepEqual([byId.quiet.reasoning, byId.quiet.thinkingOff], [true, true]);
  assert.equal(byId['always-thinks'].reasoning, false, 'no switch the client can send, so no toggle');
  assert.equal(byId.effort.reasoning, false, 'a control this client does not send is not offered');
  assert.equal(byId['no-tools'].tools, false);
  assert.deepEqual([byId.unsized.contextWindow, byId.unsized.estimated, byId.unsized.reasoning], [FALLBACK_CONTEXT, true, false], 'unknown stays unknown: a launch total is not used as a request size');
  assert.deepEqual(h.seen.map((request) => request.url), ['/v1/juiced/catalog'], 'one request, whatever the number of models');
  const models = toPiModels(found.models, { ...DEFAULTS, reasoning: ['quiet', 'effort'], vision: ['no-tools'] });
  assert.deepEqual(models.map((model) => [model.id, model.reasoning, model.input.length, model.maxTokens]),
    [['coder', true, 2, 4096], ['always-thinks', false, 1, 8192], ['effort', true, 1, 8192], ['quiet', false, 1, 8192], ['unsized', false, 1, 8192], ['no-tools', false, 2, 8192]],
    'thinking that is off by default on the host is not offered, whatever the pattern says; a pattern still fills other gaps');
});

test('Juiced: only chat models that can actually run are listed', async (t) => {
  const h = await host(t, { '/v1/juiced/catalog': { data: [
    chat('ok', { context: { observed_per_request_tokens: 8192 } }),
    chat('embeddings', { service: 'Embeddings' }),
    chat('disabled', { policy: 'disabled' }),
    chat('not-downloaded', { downloaded: false }),
    chat('unavailable', { available: false }),
    chat('incompatible', { capability_contract: { execution: { compatibility: { compatible: false } } } }),
    chat('incomplete', { capability_contract: { artifact: { components_complete: false } } }),
    chat('collection', { capability_contract: { runtime_service: false } }),
    { service: 'Chat' },
  ] } });
  const found = await discover({ baseUrl: h.baseUrl, signal: signal() });
  assert.deepEqual(found.models.map((model) => model.id), ['ok']);
});

test('a plain OpenAI-compatible host is listed through /models', async (t) => {
  const h = await host(t, { '/v1/models': { data: [{ id: 'llama', meta: { n_ctx: 16384 }, architecture: { input_modalities: ['text', 'image'] } }, { id: 'vllm', max_model_len: 65536 }, { id: 'bare' }] } });
  const found = await discover({ baseUrl: h.baseUrl, signal: signal() });
  assert.equal(found.source, 'openai');
  assert.deepEqual(found.models.map((model) => [model.id, model.contextWindow, model.estimated === true, model.vision]),
    [['llama', 16384, false, true], ['vllm', 65536, false, false], ['bare', FALLBACK_CONTEXT, true, false]]);
  await assert.rejects(discover({ baseUrl: h.baseUrl, mode: 'juiced', signal: signal() }), /no Juiced catalog/);
});

test('failures are reported, never turned into an empty catalog', async (t) => {
  const rejected = await host(t, { '/v1/juiced/catalog': { status: 401, body: {} } });
  await assert.rejects(discover({ baseUrl: rejected.baseUrl, signal: signal() }), /rejected the API key/);
  const empty = await host(t, {});
  await assert.rejects(discover({ baseUrl: empty.baseUrl, signal: signal() }), /no model list/);
  await assert.rejects(discover({ baseUrl: 'http://127.0.0.1:9/v1', signal: signal() }));
});

test('Pi model definitions: thinking is an on/off switch, output leaves room for long writes', () => {
  const descriptors = [
    { id: 'b-plain', contextWindow: 16384, reasoning: false, vision: false, tools: false, hot: false },
    { id: 'a-tools', contextWindow: 262144, reasoning: false, vision: true, tools: true, hot: false },
    { id: 'z-hot', contextWindow: 32768, reasoning: true, vision: false, tools: true, hot: true, maxOutput: 2000 },
    { id: 'hidden-model', contextWindow: 8192, reasoning: false, vision: false, tools: true, hot: true },
    { id: 'a-tools', contextWindow: 1, reasoning: false, vision: false, tools: false, hot: false },
  ];
  const models = toPiModels(descriptors, { ...DEFAULTS, exclude: ['hidden-*'], reasoning: ['B-PLAIN'] });
  assert.deepEqual(models.map((model) => model.id), ['z-hot', 'a-tools', 'b-plain'], 'always-loaded first, duplicates and excluded dropped');
  const [hot, tools, plain] = models;
  assert.deepEqual([hot.maxTokens, tools.maxTokens, plain.maxTokens], [2000, 32768, 4096]);
  assert.deepEqual(tools.input, ['text', 'image']);
  assert.equal(tools.thinkingLevelMap, undefined);
  for (const model of [hot, plain]) {
    assert.equal(model.reasoning, true);
    assert.equal(model.compat.thinkingFormat, 'qwen-chat-template');
    // T3 Code offers exactly the levels that are not null.
    assert.deepEqual(Object.entries(model.thinkingLevelMap).filter(([, value]) => value !== null).map(([level]) => level), ['off', 'medium']);
  }
});

test('small helpers', () => {
  assert.deepEqual(['', '--parallel 4', '-np 2 --parallel=3', '--parallel x', '--ctx-size 8'].map(parallelSlots), [1, 4, 3, 1, 1]);
  assert.equal(matchesAny(['Qwen3-*', 'exact'], 'qwen3-0.6b-gguf'), true);
  assert.equal(matchesAny(['exact'], 'exact-not'), false);
  assert.equal(matchesAny(['a.b'], 'axb'), false, 'a dot is literal');
  assert.equal(matchesAny(undefined, 'x'), false);
});

test('tool ranking prefers names over descriptions and exact names over everything', () => {
  const tools = [
    { name: 'mcp__t3-code__t3_thread_read', description: 'Read messages from a thread.' },
    { name: 'mcp__t3-code__t3_thread_send', description: 'Send a message. You can read the reply later.' },
    { name: 'mcp__t3-code__preview_status', description: 'Browser preview tabs.', parameters: { properties: { tabId: {} } } },
    { name: 'mcp__t3-code__device_list', description: 'List simulators.' },
  ];
  const names = (query, limit = 3) => rankTools(query, tools, limit).map((tool) => tool.name.split('__').at(-1));
  assert.deepEqual(names('read a thread'), ['t3_thread_read', 't3_thread_send']);
  assert.deepEqual(names('browser tab'), ['preview_status']);
  assert.deepEqual(names('device_list'), ['device_list']);
  assert.deepEqual(names('threads', 1), ['t3_thread_read']);
  assert.deepEqual(names('kubernetes'), []);
});
