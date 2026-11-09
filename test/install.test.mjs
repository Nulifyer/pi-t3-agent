import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProfile, parseArgs } from '../scripts/install.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-t3-installer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agent = join(directory, 'profile');
  mkdirSync(agent);
  const read = (name) => JSON.parse(readFileSync(join(agent, name), 'utf8'));
  const write = (name, value) => writeFileSync(join(agent, name), JSON.stringify(value));
  const install = (options = {}) => installProfile({ 'agent-dir': agent, ...options }, { checkPi: () => '1.5.0' });
  return { agent, directory, read, write, install };
}
const endpoint = { 'base-url': 'http://localhost:8080/v1', model: 'example-model' };

test('tool-only install preserves providers, histories, and unrelated settings', (t) => {
  const f = fixture(t);
  f.write('settings.json', { theme: 'dark', defaultProvider: 'other', defaultTools: ['read', 'bash'] });
  f.write('models.json', { providers: { other: { apiKey: 'fixture-secret', models: [] } } });
  f.write('sessions.json', { marker: 'untouched' });
  const models = readFileSync(join(f.agent, 'models.json'), 'utf8');
  const result = f.install();
  assert.ok(result.backup);
  assert.equal(f.read('settings.json').theme, 'dark');
  assert.equal(f.read('settings.json').defaultProvider, 'other');
  assert.deepEqual(f.read('settings.json').defaultTools, ['read', 'bash', '+grep', '+find', '+ls', '+tool_search']);
  assert.equal(readFileSync(join(f.agent, 'models.json'), 'utf8'), models);
  assert.deepEqual(f.read('sessions.json'), { marker: 'untouched' });
  assert.ok(existsSync(join(f.agent, 'extensions/pi-t3-agent/index.ts')));
  assert.equal(f.install().filesChanged, 0);
});
test('endpoint install uses exact IDs and environment references without changing defaults', (t) => {
  const f = fixture(t);
  f.write('settings.json', { defaultProvider: 'other', defaultModel: 'kept' });
  f.install({ ...endpoint, provider: 'custom', 'api-key-env': 'MODEL_API_KEY', reasoning: true, vision: true });
  const provider = f.read('models.json').providers.custom;
  assert.equal(provider.apiKey, '${MODEL_API_KEY}');
  assert.equal(provider.baseUrl, endpoint['base-url']);
  assert.equal(provider.models[0].id, 'example-model');
  assert.equal(provider.models[0].reasoning, true);
  assert.deepEqual(provider.models[0].input, ['text', 'image']);
  assert.equal(f.read('settings.json').defaultModel, 'kept');
  assert.equal(f.install().filesChanged, 0);
});
test('Juiced discovery starts with an empty generated snapshot and defaults are opt-in', (t) => {
  const f = fixture(t);
  f.install({ ...endpoint, discovery: 'juiced', 'set-default': true, reasoning: true });
  const provider = f.read('models.json').providers.local;
  assert.deepEqual(provider.models, []);
  assert.equal(provider.modelOverrides['example-model'].reasoning, true);
  assert.equal(f.read('settings.json').defaultProvider, 'local');
  assert.equal(f.read('settings.json').defaultModel, 'example-model');
  assert.equal(f.read('pi-t3-agent.json').discovery, 'juiced');
});
test('search is explicit and never grants private network ranges by default', (t) => {
  const f = fixture(t);
  f.write('settings.json', { packages: ['npm:some-other-package@1.0.0'] });
  f.install({ 'search-url': 'https://search.example.com' });
  const config = f.read('web-search.json');
  assert.deepEqual(config.ssrf.allowRanges, []);
  assert.deepEqual(config.webSearch.allowedProviders, ['searxng']);
  assert.equal(config.fetchRouting.allowRemoteHostedProviders, false);
  assert.deepEqual(f.read('settings.json').packages, ['npm:some-other-package@1.0.0', 'npm:pi-web-access@0.46.0']);
});
test('uninstall restores owned fields while retaining unrelated concurrent edits and backups', (t) => {
  const f = fixture(t);
  f.write('settings.json', { theme: 'dark', defaultTools: ['read'] });
  f.write('models.json', { providers: { other: { apiKey: 'fixture' } } });
  const result = f.install(endpoint);
  f.write('settings.json', { ...f.read('settings.json'), theme: 'light', custom: 42 });
  f.install({ uninstall: true });
  assert.deepEqual(f.read('settings.json'), { theme: 'light', defaultTools: ['read'], custom: 42 });
  assert.deepEqual(f.read('models.json'), { providers: { other: { apiKey: 'fixture' } } });
  assert.ok(existsSync(result.backup));
  assert.equal(existsSync(join(f.agent, 'extensions/pi-t3-agent/index.ts')), false);
  assert.equal(f.install({ uninstall: true }).filesChanged, 0);
});
test('uninstall refuses edited managed files before making any changes', (t) => {
  const f = fixture(t);
  f.install(endpoint);
  const file = join(f.agent, 'extensions/pi-t3-agent/ask-user.ts');
  writeFileSync(file, '// user edit');
  assert.throws(() => f.install({ uninstall: true }), /preserved edited/);
  assert.ok(existsSync(join(f.agent, 'extensions/pi-t3-agent/index.ts')));
  assert.equal(readFileSync(file, 'utf8'), '// user edit');
  assert.throws(() => f.install(), /Managed file was edited/);
});
test('uninstall refuses changed managed fields without removing extensions', (t) => {
  const f = fixture(t);
  f.install();
  f.write('settings.json', { ...f.read('settings.json'), defaultTools: ['read'] });
  assert.throws(() => f.install({ uninstall: true }), /defaultTools/);
  assert.ok(existsSync(join(f.agent, 'extensions/pi-t3-agent/index.ts')));
});
test('dry run does not create the profile', (t) => {
  const f = fixture(t);
  const missing = join(f.directory, 'not-created');
  const result = f.install({ ...endpoint, 'agent-dir': missing, 'dry-run': true });
  assert.ok(result.filesChanged > 0);
  assert.equal(existsSync(missing), false);
});
test('invalid input, colliding provider, malformed JSON, and conflicting web version preserve files', (t) => {
  for (const options of [
    { 'base-url': 'https://user:password@example.com/v1', model: 'x' },
    { 'base-url': 'ftp://example.com', model: 'x' },
    { ...endpoint, 'api-key-env': 'bad-name' },
    { ...endpoint, 'max-tokens': '65536' },
    { discovery: 'unknown' }, { model: 'orphan' }, { 'set-default': true },
  ]) {
    const f = fixture(t);
    assert.throws(() => f.install(options));
    assert.equal(existsSync(join(f.agent, 'settings.json')), false);
  }
  const f = fixture(t);
  f.write('models.json', { providers: { local: { apiKey: 'keep' } } });
  assert.throws(() => f.install(endpoint), /Provider ID already exists/);
  f.write('settings.json', { packages: ['npm:pi-web-access@0.1.0'] });
  assert.throws(() => f.install({ 'search-url': 'http://localhost:8081' }), /Another pi-web-access version/);
  writeFileSync(join(f.agent, 'settings.json'), '{invalid');
  assert.throws(() => f.install(), SyntaxError);
  assert.equal(existsSync(join(f.agent, 'pi-t3-agent.json')), false);
});
test('T3 opt-in preserves pairing, other providers, and Pi config fields', (t) => {
  const f = fixture(t);
  const path = join(f.directory, 't3-settings.json');
  const original = { pairing: 'fixture', providerInstances: { codex: { enabled: true }, pi: { enabled: false, config: { customModels: ['keep'] } } } };
  writeFileSync(path, JSON.stringify(original));
  f.install({ 't3-settings': path, 'pi-bin': 'example-pi' });
  const t3 = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(t3.pairing, 'fixture');
  assert.deepEqual(t3.providerInstances.codex, original.providerInstances.codex);
  assert.deepEqual(t3.providerInstances.pi.config.customModels, ['keep']);
  assert.equal(t3.providerInstances.pi.config.binaryPath, 'example-pi');
  assert.equal(t3.providerInstances.pi.config.launchArgs, '--tools +grep,+find,+ls,+tool_search');
  f.install({ uninstall: true });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
});
test('T3 custom launch arguments are preserved while the profile is connected', (t) => {
  const f = fixture(t);
  const path = join(f.directory, 't3-settings.json');
  writeFileSync(path, JSON.stringify({ providerInstances: { pi: { config: { launchArgs: '--custom' } } } }));
  f.install({ 't3-settings': path });
  const instance = JSON.parse(readFileSync(path, 'utf8')).providerInstances.pi;
  assert.equal(instance.config.launchArgs, '--custom');
  assert.equal(instance.driver, 'pi');
  assert.equal(instance.environment.find(entry => entry.name === 'PI_CODING_AGENT_DIR').value, f.agent);
});

test('new T3 instances have a driver and uninstall removes only their owned envelope', (t) => {
  const f = fixture(t), path = join(f.directory, 't3.json');
  writeFileSync(path, '{}');
  f.install({ 't3-settings': path });
  const document = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(document.providerInstances.pi.driver, 'pi');
  const profile = document.providerInstances.pi.environment[0];
  document.providerInstances.pi.environment[0] = { sensitive: false, valueRedacted: false, value: profile.value, name: profile.name };
  document.providerInstances.pi.environment.push({ name: 'KEEP', value: 'retained', sensitive: false });
  writeFileSync(path, JSON.stringify(document));
  f.install({ uninstall: true });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).providerInstances.pi.environment, [{ name: 'KEEP', value: 'retained', sensitive: false }]);
});

test('Juiced is the default for an endpoint without a hardcoded model', (t) => {
  const f = fixture(t);
  f.install({ 'base-url': 'http://localhost:8080/v1' });
  assert.equal(f.read('pi-t3-agent.json').discovery, 'juiced');
  assert.equal(f.read('settings.json').defaultModel, undefined);
});

test('legacy extensions require opt-in migration and are backed up and restored', (t) => {
  const f = fixture(t), path = join(f.agent, 'extensions', 'lemonade-tool-loadout.ts');
  mkdirSync(join(f.agent, 'extensions'));
  const source = 'pi.setActiveTools(["mcp__t3-code__delegate_task"]);';
  writeFileSync(path, source);
  assert.throws(() => f.install(), /deliberate migration/);
  f.install({ 'migrate-legacy': true });
  assert.equal(existsSync(path), false);
  f.install({ uninstall: true });
  assert.equal(readFileSync(path, 'utf8'), source);
});

test('recognized legacy Juiced providers can be adopted without changing defaults or credentials', t => {
  const f = fixture(t), path = join(f.agent, 'extensions', 'juiced-provider.ts');
  mkdirSync(join(f.agent, 'extensions'));
  writeFileSync(path, 'export default function(pi){pi.registerProvider({id:"local",name:"Juiced"});}');
  const original = { api: 'openai-completions', baseUrl: 'http://localhost:8080/v1', apiKey: 'fixture-existing-key' };
  f.write('models.json', { providers: { local: original } });
  f.write('settings.json', { defaultProvider: 'local', defaultModel: 'kept-model' });
  f.install({ 'migrate-legacy': true, provider: 'local', discovery: 'juiced' });
  assert.equal(f.read('settings.json').defaultModel, 'kept-model');
  assert.equal(f.read('models.json').providers.local.apiKey, original.apiKey);
  f.install({ uninstall: true });
  assert.deepEqual(f.read('models.json').providers.local, original);
  assert.ok(existsSync(path));
});
test('codemode-only is changed to the supported direct-tool mode', (t) => {
  const f = fixture(t);
  f.write('settings.json', { codemode: { mode: 'only', inlineBudget: 1000 } });
  f.install();
  assert.deepEqual(f.read('settings.json').codemode, { mode: 'on', inlineBudget: 1000 });
  f.install({ uninstall: true });
  assert.equal(f.read('settings.json').codemode.mode, 'only');
});
test('symlink destinations are rejected', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const outside = join(f.directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.agent, 'extensions'));
  assert.throws(() => f.install(), /symlink/);
  assert.equal(existsSync(join(outside, 'pi-t3-agent')), false);
});
test('argument parser rejects unsupported options and missing values', () => {
  assert.throws(() => parseArgs(['--api-key', 'secret']), /Unknown option/);
  assert.throws(() => parseArgs(['--base-url']), /Missing value/);
  assert.deepEqual(parseArgs(['--dry-run', '--allow-fetch-range', '127.0.0.1/32']), { 'dry-run': true, 'allow-fetch-range': ['127.0.0.1/32'] });
});
