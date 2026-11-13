// Test fixture: a disposable Pi profile, a model host that speaks the Juiced catalog and OpenAI chat
// routes, and a stand-in for T3 Code's MCP bridge. Nothing here touches the real profile or network.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../../setup.mjs';

/** Shaped like T3 Code's catalog: many tools, each with a real description and schema. */
export const t3Tools = [
  'orchestrator_capabilities', 'delegate_task', 'task_status', 'task_cancel',
  ...['list', 'read', 'search', 'send', 'wait', 'launch', 'interrupt', 'update', 'organize', 'configure'].map((verb) => `t3_thread_${verb}`),
  ...['status', 'open', 'navigate', 'act', 'snapshot', 'evaluate', 'resize', 'wait_for', 'dialog'].map((verb) => `preview_${verb}`),
  ...['list', 'open', 'screenshot', 'close'].map((verb) => `device_${verb}`),
  ...['list', 'status', 'handoff'].map((verb) => `t3_worktree_${verb}`),
  ...['list', 'read', 'create', 'update', 'delete', 'clone'].map((verb) => `t3_project_${verb}`),
  'schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task', 'request_secret', 'html_preview', 'html_render',
  'link_pull_request', 'watch_pull_request', 'unwatch_pull_request', 't3_environment_links', 't3_environment_read',
].map((name) => ({
  name,
  description: `${name.replace(/_/g, ' ')}: ${'Operates on the matching T3 Code resource and returns its current state. '.repeat(5)}`,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(['threadId', 'environmentId', 'options', 'timeoutMs'].map((key) => [key, { type: 'string', description: `The ${key} this ${name} call applies to, as returned by an earlier call.` }])),
  },
}));

// Mirrors the parts of T3 Code's generated bridge these tests depend on: deferred registration, forced
// activation of the whole catalog for openai-completions models, and its own prompt section.
// Set PI_T3_TEST_BRIDGE to T3 Code's real bridge file to run the same tests against it.
const BRIDGE = `import { Type } from "typebox";
export default async function (pi) {
  const call = async (method, params) => (await (await fetch(process.env.T3_MCP_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
  const { tools } = await call("tools/list", {});
  const direct = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
  for (const tool of tools) pi.registerTool({
    name: "mcp__t3-code__" + tool.name, label: tool.name, description: tool.description, parameters: Type.Unsafe(tool.inputSchema),
    exposure: direct.has(tool.name) ? "direct" : "deferred",
    async execute(_id, args) { const result = await call("tools/call", { name: tool.name, arguments: args }); return { content: result.content, details: { server: "t3-code", tool: tool.name } }; },
  });
  const reconcile = (ctx) => {
    const active = pi.getActiveTools();
    const required = ["tool_search", ...(ctx.model?.api === "openai-completions" ? tools.map((tool) => "mcp__t3-code__" + tool.name) : [])];
    const missing = required.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  };
  pi.on("session_start", (_event, ctx) => reconcile(ctx));
  pi.on("session_tree", (_event, ctx) => reconcile(ctx));
  pi.on("model_select", (_event, ctx) => reconcile(ctx));
  pi.on("before_agent_start", (event, ctx) => { reconcile(ctx); event.systemPromptOptions.sections.t3_code_orchestration = "T3_ORCHESTRATION_FIXTURE"; });
}
`;

// The shape Juiced 1.0 returns (discovery schema 1). test/catalog.test.mjs also covers Juiced 0.9.
const juicedEntry = (model) => {
  const chat = !model.operations || model.operations.includes('chat/completions');
  const slots = model.parallel ?? 1;
  return {
    id: model.id, operations: model.operations ?? ['chat/completions', 'completions', 'responses'], policy: model.policy ?? 'on-demand',
    downloaded: true, loaded: model.loaded === true, state: model.loaded ? 'ready' : 'unloaded', implementation_id: 'llama-cpp',
    // The launch total covers every slot; one request gets its share.
    context: chat
      ? { schema_version: 1, per_request_tokens: model.context, per_request_source: 'configured', configured_tokens: model.context * slots, configured_slots: slots }
      : { schema_version: 1, per_request_tokens: null, per_request_source: null },
    vision: model.vision === true,
    thinking: model.thinking
      ? { supported: true, request_control: 'chat_template_kwargs.enable_thinking', default: model.thinking, source: 'gguf_chat_template' }
      : { supported: false, source: chat ? 'gguf_chat_template' : 'operations' },
    tool_calls: { supported: chat, source: chat ? 'gguf_chat_template' : 'operations' },
  };
};

export async function fixture({ models = [{ id: 'big', context: 131072 }], configure = true, setupOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-t3-agent-'));
  const paths = { home: join(root, 'home'), profile: join(root, 'home', '.pi', 'agent'), work: join(root, 'work'), bridge: join(root, 'bridge.ts') };
  for (const path of [paths.profile, paths.work]) mkdirSync(path, { recursive: true });
  writeFileSync(paths.bridge, BRIDGE);

  const host = { models, outage: false, apiKey: undefined, catalogRequests: 0, completions: [], mcpCalls: [], reply: () => ({ text: 'DONE' }) };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const json = (value, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.url === '/mcp') {
      const message = JSON.parse(body);
      if (message.id === undefined) return void response.writeHead(202).end();
      if (message.method === 'tools/call') host.mcpCalls.push(message.params);
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : message.method === 'tools/list' ? { tools: t3Tools }
        : { content: [{ type: 'text', text: `MCP_RESULT ${message.params?.name}` }] };
      return json({ jsonrpc: '2.0', id: message.id, result });
    }
    if (host.apiKey && request.headers.authorization !== `Bearer ${host.apiKey}`) return json({ error: 'unauthorized' }, 401);
    if (request.method === 'GET') {
      if (host.outage) return json({}, 503);
      if (request.url === '/v1/juiced/catalog') {
        host.catalogRequests++;
        return host.plainOpenAi ? json({}, 404) : json({ object: 'list', schema_version: 1, discovery_schema_version: 1, data: host.models.map(juicedEntry) });
      }
      if (request.url === '/v1/models') return json({ object: 'list', data: host.models.map((model) => ({ id: model.id, meta: { n_ctx: model.context } })) });
      return json({}, 404);
    }
    const payload = JSON.parse(body);
    host.completions.push(payload);
    const reply = await host.reply(payload, host.completions.length - 1);
    const delta = reply.tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${host.completions.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] }
      : { role: 'assistant', content: reply.text ?? 'DONE' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [chunk, finish] of [[delta, null], [{}, reply.tool ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  host.url = `http://127.0.0.1:${server.address().port}`;

  const runSetup = (options = {}) => setup(
    { 'agent-dir': paths.profile, 'base-url': `${host.url}/v1`, 'no-t3': true, 'refresh-seconds': '1', ...setupOptions, ...options },
    { log: () => {}, checkPi: () => '1.5.2' },
  );
  if (configure) await runSetup();

  const children = new Set();
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
    await closed;
  };

  /** Start `pi --mode rpc`. `bridge: false` and extra `args` reproduce T3 Code's helper launches. */
  function client({ args = [], bridge = true, cwd = paths.work, env = {} } = {}) {
    const bridgePath = process.env.PI_T3_TEST_BRIDGE ?? paths.bridge;
    const environment = {
      ...process.env, HOME: paths.home, USERPROFILE: paths.home, PI_CODING_AGENT_DIR: paths.profile, PI_TELEMETRY: '0',
      T3_MCP_URL: `${host.url}/mcp`, T3_MCP_BEARER_TOKEN: 'fixture', T3_PI_RUNTIME_MODE: 'full-access', T3_PI_MCP_EXTENSION_PATH: bridgePath, ...env,
    };
    delete environment.PI_OFFLINE;
    const child = spawn(process.platform === 'win32' ? 'pi.cmd' : 'pi', ['--mode', 'rpc', ...(bridge ? ['--extension', bridgePath] : []), ...args],
      { cwd, env: environment, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let buffer = '', stderr = '', nextId = 1;
    const events = [], pending = new Map(), listeners = new Set();
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        events.push(event);
        if (event.type === 'response' && pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
        for (const listener of listeners) listener(event);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', () => children.delete(child));
    const request = (type, fields = {}, timeout = 20000) => new Promise((resolve, reject) => {
      const id = `test-${nextId++}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out. stderr: ${stderr.slice(-1500)}`)); }, timeout);
      pending.set(id, (event) => { clearTimeout(timer); resolve(event); });
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
    });
    const waitFor = (predicate, timeout = 20000, from = 0) => new Promise((resolve, reject) => {
      const seen = events.slice(from).find(predicate);
      if (seen) return resolve(seen);
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out waiting for an event. stderr: ${stderr.slice(-1500)}`)); }, timeout);
      const listener = (event) => { if (predicate(event)) { clearTimeout(timer); listeners.delete(listener); resolve(event); } };
      listeners.add(listener);
    });
    /** Send a prompt and wait until the agent has fully settled. Commands settle immediately. */
    const prompt = async (message) => {
      const from = events.length;
      const response = await request('prompt', { message });
      if (response.success && response.data?.disposition !== 'handled') await waitFor((event) => event.type === 'agent_settled', 30000, from);
      return response;
    };
    return {
      events, request, waitFor, prompt,
      send: (record) => child.stdin.write(JSON.stringify(record) + '\n'),
      toolResults: (name) => events.filter((event) => event.type === 'tool_execution_end' && event.toolName === name),
      errors: () => events.filter((event) => event.type === 'extension_error'),
      notices: () => events.filter((event) => event.type === 'extension_ui_request' && event.method === 'notify').map((event) => event.message),
      close: () => stop(child),
    };
  }

  return {
    paths, host, client, setup: runSetup,
    /** Names of the tools declared in a recorded chat request. */
    declared: (payload) => (payload.tools ?? []).map((tool) => tool.function.name),
    async close() {
      await Promise.all([...children].map(stop));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // On Windows the last process of a stopped Pi can hold the folder for a moment after its shell exits.
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

export async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
