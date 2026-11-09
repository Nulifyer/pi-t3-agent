import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProfile } from '../scripts/install.mjs';

test('installed extension discovers a Juiced model and streams through real Pi with direct tools', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-t3-integration-'));
  const agent = join(directory, 'profile');
  const captured = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      const data = request.url === '/v1/juiced/catalog' ? { data: [
        { id: 'fixture-model', service: 'Chat', downloaded: true, policy: 'hot', recipe: 'llamacpp', labels: [] },
      ] } : request.url === '/v1/health' ? { all_models_loaded: [] } :
        { resolved_ctx_size: 16384, effective: { llamacpp_args: '--parallel 1' } };
      response.end(JSON.stringify(data));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    captured.push(data);
    response.setHeader('Content-Type', 'text/event-stream');
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'FIXTURE_READY' }, null], [{}, 'stop']]) {
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
        model: data.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  const result = installProfile({ 'agent-dir': agent, 'base-url': `http://127.0.0.1:${server.address().port}/v1`,
    discovery: 'juiced', model: 'fixture-model', 'set-default': true });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: '0' };
  delete env.PI_OFFLINE;
  const child = spawn(process.platform === 'win32' ? 'pi.cmd' : 'pi',
    ['--mode', 'json', '--no-session', '--no-mcp', '--no-skills', '--no-context-files', '-p', 'Fixture.'],
    { cwd: directory, env, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  clearTimeout(timer);
  assert.equal(code, 0, stderr + stdout);
  assert.equal(result.installed, true);
  assert.match(stdout, /FIXTURE_READY/);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].model, 'fixture-model');
  const names = captured[0].tools.map((tool) => tool.function.name);
  for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'tool_search', 'command_session', 'update_plan', 'ask_user']) assert.ok(names.includes(name), name);
  assert.equal(names.includes('codemode'), false);
});
