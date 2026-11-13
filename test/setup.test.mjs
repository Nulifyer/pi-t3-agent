import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATE_FILE } from '../lib/config.mjs';
import { applyCatalog, resolveApiKey, syncCatalog } from '../lib/sync.mjs';
import { findPi, ownLauncher, parseArgs, setup } from '../setup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };

async function environment(t, { key } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-t3-setup-'));
  const host = { models: ['alpha', 'beta'], down: false, requests: 0 };
  const server = createServer((request, response) => {
    host.requests++;
    if (host.down) return void response.writeHead(503).end('{}');
    if (key && request.headers.authorization !== `Bearer ${key}`) return void response.writeHead(401).end('{}');
    const body = request.url === '/v1/juiced/catalog'
      ? { data: host.models.map((id) => ({ id, service: 'Chat', policy: 'on-demand', downloaded: true, context: { observed_per_request_tokens: 65536 } })) }
      : undefined;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
  const agent = join(root, 'agent');
  const t3 = join(root, 't3', 'settings.json');
  const lines = [];
  const run = (options = {}, system = {}) => setup({ 'agent-dir': agent, 't3-settings': t3, ...options }, { log: (line) => lines.push(line), checkPi: () => '1.5.2', ...system });
  return { agent, t3, host, lines, run, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('a fresh setup configures Pi, syncs models and enables Pi in T3 Code', async (t) => {
  const e = await environment(t);
  write(e.t3, { providerInstances: { codex: { driver: 'codex', enabled: true } }, other: 1 });
  const result = await e.run({ 'base-url': e.baseUrl + '/', reasoning: ['alpha'] });
  assert.deepEqual(result.models, ['alpha', 'beta']);

  const provider = read(join(e.agent, 'models.json')).providers.juiced;
  assert.equal(provider.baseUrl, e.baseUrl, 'trailing slash removed');
  assert.deepEqual([provider.api, provider.apiKey], ['openai-completions', 'local']);
  assert.deepEqual(provider.models.map((model) => [model.id, model.reasoning]), [['alpha', true], ['beta', false]]);
  const settings = read(join(e.agent, 'settings.json'));
  assert.deepEqual(settings.packages, [ROOT]);
  assert.deepEqual(settings.defaultTools, ['+grep', '+find', '+ls']);
  assert.deepEqual([settings.defaultProvider, settings.defaultModel], ['juiced', 'alpha']);
  assert.equal(settings.defaultProjectTrust, undefined);

  const t3 = read(e.t3);
  assert.deepEqual(t3.providerInstances.pi, { driver: 'pi', enabled: true, config: { binaryPath: 'pi' }, environment: [{ name: 'PI_CODING_AGENT_DIR', value: e.agent, sensitive: false }] });
  assert.deepEqual([t3.providerInstances.codex, t3.other], [{ driver: 'codex', enabled: true }, 1], 'everything else is untouched');
  assert.ok(existsSync(e.t3 + '.pi-t3-agent.bak'));

  // Running it again changes nothing and does not need the URL repeated.
  const before = [readFileSync(join(e.agent, 'models.json'), 'utf8'), readFileSync(join(e.agent, 'settings.json'), 'utf8'), readFileSync(e.t3, 'utf8')];
  assert.equal((await e.run()).t3, 'unchanged');
  assert.deepEqual([readFileSync(join(e.agent, 'models.json'), 'utf8'), readFileSync(join(e.agent, 'settings.json'), 'utf8'), readFileSync(e.t3, 'utf8')], before);
});

test('setup takes over a profile left by the earlier release and keeps what the user set', async (t) => {
  const e = await environment(t, { key: 'k$ey' });
  write(join(e.agent, 'pi-t3-agent.json'), { commandShell: 'bash', provider: 'myhost', discovery: 'juiced' });
  write(join(e.agent, 'pi-t3-agent-install.json'), { version: 2 });
  write(join(e.agent, 'pi-t3-agent-catalog.json'), { version: 1 });
  write(join(e.agent, 'extensions', 'pi-t3-agent', 'index.ts'), 'old');
  write(join(e.agent, 'extensions', 'lib', 'juiced-catalog.ts'), 'old');
  write(join(e.agent, 'extensions', 'mine.ts'), 'user extension');
  write(join(e.agent, 'settings.json'), { defaultProvider: 'myhost', defaultModel: 'beta', defaultThinkingLevel: 'low', packages: ['npm:pi-web-access@0.46.0'], defaultTools: ['+grep', '+tool_search'] });
  write(join(e.agent, 'models.json'), { providers: {
    myhost: { baseUrl: e.baseUrl, api: 'openai-completions', apiKey: 'k$$ey', modelOverrides: { beta: { reasoning: true, samplingParams: { top_k: 20 } } }, models: [{ id: 'stale' }, { id: 'alpha', input: ['text', 'image'] }] },
    other: { baseUrl: 'http://example.invalid/v1' },
  } });
  write(e.t3, { providerInstances: { pi: { driver: 'pi', enabled: false, config: { binaryPath: '/opt/pi', launchArgs: '--tools +grep,+find,+ls,+tool_search', customModels: [] } } } });

  const result = await e.run();
  assert.deepEqual(result.models, ['alpha', 'beta'], 'the stored key and URL were reused');
  for (const gone of ['pi-t3-agent-install.json', 'pi-t3-agent-catalog.json', 'extensions/pi-t3-agent', 'extensions/lib']) assert.equal(existsSync(join(e.agent, gone)), false, gone);
  assert.equal(readFileSync(join(e.agent, 'extensions', 'mine.ts'), 'utf8'), '"user extension"');
  assert.ok(e.lines.some((line) => /saved in/.test(line)), 'replaced files are kept');

  const config = read(join(e.agent, 'pi-t3-agent.json'));
  assert.deepEqual(config, { provider: 'myhost', discovery: 'juiced', reasoning: ['beta'], vision: ['alpha'] }, 'provider name kept so existing threads still resolve; thinking and image support carried over');
  const models = read(join(e.agent, 'models.json'));
  assert.deepEqual(models.providers.other, { baseUrl: 'http://example.invalid/v1' });
  assert.deepEqual(models.providers.myhost.modelOverrides, { beta: { reasoning: true, samplingParams: { top_k: 20 } } });
  assert.deepEqual(models.providers.myhost.models.map((model) => [model.id, model.reasoning, model.input.length]), [['alpha', false, 2], ['beta', true, 1]]);
  const settings = read(join(e.agent, 'settings.json'));
  assert.deepEqual(settings.packages, ['npm:pi-web-access@0.46.0', ROOT]);
  assert.deepEqual([settings.defaultModel, settings.defaultThinkingLevel], ['beta', 'low'], 'a valid default is not replaced');
  assert.deepEqual(settings.defaultTools, ['+grep', '+tool_search', '+find', '+ls']);
  assert.deepEqual(read(e.t3).providerInstances.pi, { driver: 'pi', enabled: true, config: { binaryPath: '/opt/pi', launchArgs: '', customModels: [] }, environment: [{ name: 'PI_CODING_AGENT_DIR', value: e.agent, sensitive: false }] });
});

test('setup options: keys, defaults, trust, unreachable host, removal', async (t) => {
  const e = await environment(t);
  await assert.rejects(e.run(), /Pass --base-url/);
  await assert.rejects(e.run({ 'base-url': 'ftp://host/v1' }), /plain http/);
  await assert.rejects(e.run({ 'base-url': 'https://user:pass@host/v1' }), /plain http/);
  await assert.rejects(e.run({ 'base-url': e.baseUrl, 'api-key': 'a', 'api-key-env': 'B' }), /not both/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['--base-url']), /needs a value/);
  assert.deepEqual(parseArgs(['--exclude', 'a', '--exclude', 'b', '--no-t3']), { exclude: ['a', 'b'], 'no-t3': true });

  e.host.down = true;
  const offline = await e.run({ 'base-url': e.baseUrl, 'api-key-env': 'HOST_KEY', 'trust-projects': true, 'no-t3': true });
  assert.deepEqual([offline.sync, offline.models, offline.t3], ['stale', [], 'skipped'], 'an unreachable host does not block setup');
  assert.ok(e.lines.some((line) => /Model host check failed/.test(line)));
  assert.ok(e.lines.some((line) => /add HOST_KEY/.test(line)));
  assert.equal(read(join(e.agent, 'models.json')).providers.juiced.apiKey, '$HOST_KEY');
  assert.equal(read(join(e.agent, 'settings.json')).defaultProjectTrust, 'always');
  assert.equal(existsSync(e.t3), false);

  e.host.down = false;
  await e.run({ 'api-key': '!literal$key', 'default-model': 'beta', exclude: ['alpha'], 'no-t3': true });
  assert.equal(read(join(e.agent, 'models.json')).providers.juiced.apiKey, '$!literal$$key', "a literal key is escaped from Pi's variable syntax");
  assert.equal(resolveApiKey('$!literal$$key'), '!literal$key');
  assert.equal(read(join(e.agent, 'settings.json')).defaultModel, 'beta');
  assert.deepEqual(read(join(e.agent, 'models.json')).providers.juiced.models.map((model) => model.id), ['beta']);

  await assert.rejects(e.run({ 'default-model': 'missing', 'no-t3': true }), /not served/);

  await e.run({ status: true });
  assert.ok(e.lines.some((line) => /Package:\s+registered/.test(line)));
  await e.run({ remove: true });
  assert.deepEqual(read(join(e.agent, 'settings.json')).packages, []);
  assert.equal(existsSync(join(e.agent, 'pi-t3-agent.json')), false);
  assert.equal(read(join(e.agent, 'models.json')).providers.juiced.models.length, 1, 'last known models stay usable');
});

test('on Windows the launcher file is found and T3 Code is given its full path', async (t) => {
  const e = await environment(t, { '/v1/juiced/catalog': { data: [{ id: 'alpha', operations: ['chat/completions'], policy: 'on-demand', downloaded: true }] } });
  // What Pi's Windows installer leaves in the profile: PowerShell runs pi.ps1, programs need pi.cmd.
  const managed = join(e.agent, 'bin');
  const elsewhere = join(dirname(e.agent), 'on path');
  for (const directory of [managed, elsewhere]) mkdirSync(directory, { recursive: true });
  for (const name of ['pi', 'pi.ps1', 'pi.cmd']) writeFileSync(join(managed, name), '');
  writeFileSync(join(elsewhere, 'pi.ps1'), '');
  const windows = (binary, env = {}) => findPi(binary, { platform: 'win32', env, agent: e.agent });

  assert.equal(findPi('pi', { platform: 'linux', env: {}, agent: e.agent }), 'pi', 'other systems start the name as it is');
  assert.equal(windows('pi', { Path: `"${elsewhere}";${managed}` }), join(managed, 'pi.cmd'), 'a script-only folder is passed over');
  assert.equal(windows('pi', { PATH: elsewhere }), join(managed, 'pi.cmd'), "the installer's folder is searched even when PATH predates the install");
  assert.equal(windows(join(managed, 'pi.ps1')), join(managed, 'pi.cmd'), 'a script path resolves to the launcher beside it');
  assert.equal(windows(join(elsewhere, 'pi.ps1')), join(elsewhere, 'pi.ps1'), 'nothing startable: left for the version check to report');
  rmSync(join(managed, 'pi.cmd'));
  assert.equal(windows('pi', { PATH: elsewhere }), 'pi');
  writeFileSync(join(managed, 'pi.cmd'), '');

  mkdirSync(dirname(e.t3), { recursive: true });
  write(e.t3, { providerInstances: { pi: { driver: 'pi', enabled: false, config: { binaryPath: 'pi' } } } });
  const checked = [];
  await e.run({ 'base-url': e.baseUrl }, { platform: 'win32', env: { PATH: elsewhere }, checkPi: (binary) => (checked.push(binary), '1.5.2') });
  assert.deepEqual(checked, [join(managed, 'pi.cmd')]);
  assert.equal(read(e.t3).providerInstances.pi.config.binaryPath, join(managed, 'pi.cmd'), 'a bare name would depend on the PATH T3 Code was started with');
});

test('on Windows setup writes a launcher that names Node.js by its full path', async (t) => {
  const e = await environment(t);
  // Pi's own pi.cmd starts `node` by name, which fails wherever PATH lacks Node.js.
  const node = 'C:\\Program Files (x86)\\nodejs\\node.exe';
  const own = (found, options = {}) => ownLauncher(found, e.agent, { platform: 'win32', node, ...options });
  const launcher = join(e.agent, 'pi-t3-agent.cmd');

  // npm's layout: the package beside pi.cmd.
  const npm = join(dirname(e.agent), 'npm');
  const packaged = join(npm, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(packaged, 'dist'), { recursive: true });
  write(join(packaged, 'package.json'), { bin: { pi: 'dist/cli.js' } });
  for (const path of [join(packaged, 'dist', 'cli.js'), join(npm, 'pi.cmd')]) writeFileSync(path, '');
  assert.equal(own(join(npm, 'pi.cmd')), launcher);
  assert.deepEqual(readFileSync(launcher, 'utf8').split('\r\n'),
    ['@ECHO off', 'SETLOCAL', `SET "node=${node}"`, 'IF NOT EXIST "%node%" SET "node=node"', `"%node%" "${join(packaged, 'dist/cli.js')}" %*`, '']);

  // Pi's installer's layout: pi-launcher.js beside pi.cmd.
  const managed = join(e.agent, 'bin');
  mkdirSync(managed, { recursive: true });
  for (const name of ['pi.cmd', 'pi-launcher.js']) writeFileSync(join(managed, name), '');
  assert.equal(own(join(managed, 'pi.cmd')), launcher);
  assert.ok(readFileSync(launcher, 'utf8').includes(`"%node%" "${join(managed, 'pi-launcher.js')}" %*`));

  const other = join(dirname(e.agent), 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'pi.cmd'), '');
  assert.equal(own(join(other, 'pi.cmd')), join(other, 'pi.cmd'), "an unknown layout keeps Pi's launcher");
  assert.equal(own(join(npm, 'pi.exe')), join(npm, 'pi.exe'), 'a program file needs no launcher');
  assert.equal(own(join(npm, 'pi.cmd'), { node: 'C:\\Users\\Zo\u00eb\\node.exe' }), join(npm, 'pi.cmd'), 'a path cmd.exe could misread is not written');
  assert.equal(own(join(npm, 'pi.cmd'), { node: 'C:\\100%\\node.exe' }), join(npm, 'pi.cmd'));
  assert.equal(own(join(npm, 'pi.cmd'), { platform: 'linux' }), join(npm, 'pi.cmd'));

  // T3 Code is given the launcher, also in place of the path an earlier run wrote.
  mkdirSync(dirname(e.t3), { recursive: true });
  write(e.t3, { providerInstances: { pi: { driver: 'pi', enabled: true, config: { binaryPath: join(managed, 'pi.cmd') } } } });
  const checked = [];
  await e.run({ 'base-url': e.baseUrl }, { platform: 'win32', env: { PATH: managed }, node, checkPi: (binary) => (checked.push(binary), '1.5.2') });
  assert.deepEqual(checked, [launcher]);
  assert.equal(read(e.t3).providerInstances.pi.config.binaryPath, launcher);
});

test('sync: one request per refresh window, last catalog kept on failure', async (t) => {
  const e = await environment(t);
  await e.run({ 'base-url': e.baseUrl, 'refresh-seconds': '60', 'no-t3': true });
  const requests = e.host.requests;
  assert.equal((await syncCatalog(e.agent)).status, 'fresh');
  assert.equal(e.host.requests, requests, 'no request inside the window');

  e.host.models = ['alpha', 'beta', 'gamma'];
  const synced = await syncCatalog(e.agent, { force: true });
  assert.deepEqual([synced.status, synced.changed, synced.state.count], ['synced', true, 3]);
  const again = await syncCatalog(e.agent, { force: true });
  assert.equal(again.changed, false, 'an unchanged catalog does not rewrite models.json');

  e.host.down = true;
  const failed = await syncCatalog(e.agent, { force: true });
  assert.equal(failed.status, 'stale');
  assert.match(failed.state.error, /no model list/);
  assert.equal(read(join(e.agent, 'models.json')).providers.juiced.models.length, 3);
  assert.equal((await syncCatalog(e.agent)).status, 'stale', 'a failure also waits out the window');
  assert.equal(read(join(e.agent, STATE_FILE)).lastSuccess, again.state.lastSuccess, 'the time of the last good sync is kept');

  e.host.down = false;
  const recovered = await syncCatalog(e.agent, { force: true });
  assert.deepEqual([recovered.status, recovered.state.error], ['synced', undefined]);

  writeFileSync(join(e.agent, 'pi-t3-agent.json'), JSON.stringify({ provider: 'juiced', discovery: 'off' }));
  assert.equal((await syncCatalog(e.agent, { force: true })).status, 'disabled');
  rmSync(join(e.agent, 'pi-t3-agent.json'));
  assert.equal((await syncCatalog(e.agent)).status, 'unconfigured');
});

test('applyCatalog replaces only the model list; resolveApiKey follows Pi syntax', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-t3-apply-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'models.json');
  write(path, { $schema: 'x', providers: { juiced: { baseUrl: 'u', headers: { a: 'b' }, modelOverrides: { m: { maxTokens: 9 } }, models: [{ id: 'old' }] }, other: { models: [{ id: 'keep' }] } } });
  assert.equal(applyCatalog(directory, 'juiced', [{ id: 'new' }]), true);
  assert.deepEqual(read(path), { $schema: 'x', providers: { juiced: { baseUrl: 'u', headers: { a: 'b' }, modelOverrides: { m: { maxTokens: 9 } }, models: [{ id: 'new' }] }, other: { models: [{ id: 'keep' }] } } });
  assert.equal(applyCatalog(directory, 'juiced', [{ id: 'new' }]), false);
  assert.throws(() => applyCatalog(directory, 'missing', []), /missing from models.json/);

  const env = { KEY: 'value', OTHER: 'x' };
  assert.deepEqual(['literal', '$KEY', '${KEY}', 'a-${KEY}-$OTHER', '$$KEY', '$UNSET', '', undefined].map((value) => resolveApiKey(value, env)),
    ['literal', 'value', 'value', 'a-value-x', '$KEY', undefined, undefined, undefined]);
  if (process.platform !== 'win32') assert.equal(resolveApiKey('!printf from-command'), 'from-command');
});
