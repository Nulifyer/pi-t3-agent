import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProfile } from '../../scripts/install.mjs';

export async function fixture({ discovery = false, refreshSeconds = 5 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-t3-deep-'));
  const profile = join(directory, 'profile');
  const requests = [], completions = [];
  let catalog = [{ id: 'fixture-a', context: 16384 }], outage = false;
  let reply = () => ({ text: 'FIXTURE_DONE' });
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      if (outage) { res.writeHead(503).end('{}'); return; }
      if (req.url.endsWith('/juiced/catalog')) res.end(JSON.stringify({ data: catalog.map(m => ({ id: m.id, service: 'Chat', downloaded: true, policy: 'hot', recipe: 'llamacpp', labels: ['tool-calling'] })) }));
      else if (req.url.endsWith('/health')) res.end(JSON.stringify({ all_models_loaded: [] }));
      else { const m = catalog.find(m => req.url.includes(encodeURIComponent(m.id))); res.end(JSON.stringify({ resolved_ctx_size: m?.context ?? 16384, effective: { llamacpp_args: '--parallel 1' } })); }
      return;
    }
    const data = JSON.parse(body || '{}');
    if (req.url === '/mcp') {
      if (data.id === undefined) { res.writeHead(202).end(); return; }
      const result = data.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : data.method === 'tools/list' ? { tools: t3ToolNames.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) } : { content: [{ type: 'text', text: JSON.stringify({ fixture: true, tool: data.params?.name }) }] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result })); return;
    }
    completions.push(data);
    res.setHeader('Content-Type', 'text/event-stream');
    const selected = await reply(data, completions.length - 1);
    const delta = selected.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + completions.length, type: 'function', function: { name: selected.tool, arguments: JSON.stringify(selected.args ?? {}) } }] } : { role: 'assistant', content: selected.text ?? 'FIXTURE_DONE' };
    for (const [chunk, finish_reason] of [[delta, null], [{}, selected.tool ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: data.model, choices: [{ index: 0, delta: chunk, finish_reason }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  installProfile({ 'agent-dir': profile, 'base-url': base + '/v1', model: 'fixture-a', 'set-default': true, ...(discovery ? { discovery: 'juiced', 'catalog-refresh-seconds': String(refreshSeconds) } : {}) });
  const fixtureBridge = join(directory, 't3-contract.ts');
  writeFileSync(fixtureBridge, `import { Type } from '@earendil-works/pi-ai';
export default function(pi) {
 const names = ${JSON.stringify(t3ToolNames)};
 for (const name of names) pi.registerTool({ name:'mcp__t3-code__'+name,label:name,description:name,parameters:Type.Object({}, {additionalProperties:true}),exposure:'deferred',
  async execute(_id,args,signal) { const r=await fetch(process.env.T3_MCP_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),signal});return (await r.json()).result; } });
 pi.on('before_agent_start',()=>pi.setActiveTools([...new Set([...pi.getActiveTools(),...names.map(n=>'mcp__t3-code__'+n)])]));
}`);
  const otherExtension = join(directory, 'other-extension.ts');
  writeFileSync(otherExtension, `import {Type} from '@earendil-works/pi-ai'; export default function(pi){pi.registerTool({name:'fixture_other',label:'Other extension tool',description:'Fixture tool',parameters:Type.Object({}),async execute(){return {content:[{type:'text',text:'other extension completed'}]};}});}`);
  const children = new Set();
  const terminate = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => { killer.once('error', resolve); killer.once('close', resolve); });
    } else child.kill();
    await closed;
  };
  async function client({ offline = false, extra = [], context = false, bridge: withBridge = true, environment = {}, trustArgs = ['--no-approve'] } = {}) {
    const bridge = process.env.PI_T3_TEST_BRIDGE ?? fixtureBridge;
    const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_TELEMETRY: '0', T3_MCP_URL: base + '/mcp', T3_MCP_BEARER_TOKEN: 'fixture-only', T3_PI_RUNTIME_MODE: 'full-access', T3_PI_MCP_EXTENSION_PATH: bridge };
    delete env.PI_OFFLINE;
    Object.assign(env, environment);
    const child = spawn(process.platform === 'win32' ? 'pi.cmd' : 'pi', ['--mode', 'rpc', '--no-mcp', '--no-skills', ...context ? [] : ['--no-context-files'], ...trustArgs, ...withBridge ? ['--extension', bridge, '--extension', otherExtension] : [], ...offline ? ['--offline'] : [], ...extra], { cwd: directory, env, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let buffer = '', stderr = '', next = 1;
    const pending = new Map(), events = [], listeners = new Set();
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0,index); buffer = buffer.slice(index + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        events.push(event);
        if (event.type === 'response' && pending.has(event.id)) { const p = pending.get(event.id); pending.delete(event.id); clearTimeout(p.timer); p.resolve(event); }
        for (const listener of listeners) listener(event);
      }
    });
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('close', () => { children.delete(child); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Pi exited: ' + stderr)); } pending.clear(); });
    function request(type, fields = {}) {
      const id = 'probe-' + next++;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(type + ' timed out; stderr=' + stderr)); }, 15000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
      });
    }
    async function prompt(message) {
      let cancel;
      const settled = new Promise((resolve,reject) => {
        const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Prompt did not settle')); }, 15000);
        const listener = e => { if (e.type === 'agent_settled') { listeners.delete(listener); clearTimeout(timer); resolve(e); } };
        listeners.add(listener);
        cancel = () => { listeners.delete(listener); clearTimeout(timer); resolve(); };
      });
      const response = await request('prompt', { message });
      if (!response.success || response.data?.disposition === 'handled') cancel(); else await settled;
      return response;
    }
    return { request, prompt, events, pid: child.pid, send: record => child.stdin.write(JSON.stringify(record) + '\n'), get stderr() { return stderr; }, close: () => terminate(child) };
  }
  return { directory, profile, requests, completions, client,
    setReply(value) { reply = value; },
    setCatalog(value) { catalog = value; }, setOutage(value) { outage = value; },
    async close() { await Promise.all([...children].map(terminate)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); } };
}

export const t3ToolNames = ['orchestrator_capabilities', 'delegate_task', 'task_cancel', 'task_status', 't3_thread_search', 't3_thread_list', 't3_thread_read', 't3_thread_send', 't3_thread_wait', 't3_environment_links', 'preview_status', 'preview_act', 'request_secret', 'watch_pull_request'];

export async function until(check, timeout = 10000) {
 const deadline = Date.now() + timeout;
 while (!(await check())) { if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
