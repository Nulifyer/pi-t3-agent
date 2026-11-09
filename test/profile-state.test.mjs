import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProfile } from '../scripts/install.mjs';
import { catalogFilename, publishCatalog, readCatalog, withProfileLock } from '../extensions/lib/profile-state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-t3-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = options => installProfile({ 'agent-dir': root, ...options }, { checkPi: () => '1.5.0' });
  install({ 'base-url': 'http://localhost:8080/v1' });
  const model = id => ({ id, name: id, provider: 'local', baseUrl: 'http://localhost:8080/v1', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 16384, maxTokens: 4096 });
  return { root, install, model, models: () => JSON.parse(readFileSync(join(root, 'models.json'), 'utf8')) };
}

test('generated catalogs preserve preferences, reject stale writers and remove retired models', t => {
  const f = fixture(t);
  const original = f.models(); original.providers.local.modelOverrides = { 'fixture-a': { samplingParams: { temperature: 0.7 } } };
  writeFileSync(join(f.root, 'models.json'), JSON.stringify(original));
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('fixture-a')], 100);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('fixture-b')], 200);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('stale')], 150);
  assert.deepEqual(f.models().providers.local.models.map(model => model.id), ['fixture-b']);
  assert.deepEqual(f.models().providers.local.modelOverrides, original.providers.local.modelOverrides);
  assert.equal(f.models().providers.local.models[0].provider, undefined);
  assert.equal(f.models().providers.local.models[0].baseUrl, undefined);
  assert.equal(readCatalog(f.root, 'local', 'http://other.example/v1'), undefined);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [], 300);
  assert.deepEqual(f.models().providers.local.models, []);
});

test('uninstall accepts generated changes and retains operator preferences across upgrades', t => {
  const f = fixture(t);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('fixture-a')]);
  const document = f.models(); document.providers.local.modelOverrides = { 'fixture-a': { reasoning: true } };
  writeFileSync(join(f.root, 'models.json'), JSON.stringify(document));
  f.install(); f.install({ uninstall: true });
  assert.deepEqual(f.models().providers.local, document.providers.local);
  assert.equal(existsSync(join(f.root, catalogFilename)), false);
  assert.equal(existsSync(join(f.root, 'extensions', 'pi-t3-agent', 'index.ts')), false);
});

test('uninstall removes an unchanged generated provider and rejects edited generated models', t => {
  const f = fixture(t);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('fixture-a')]);
  const changed = f.models(); changed.providers.local.models[0].contextWindow = 999;
  writeFileSync(join(f.root, 'models.json'), JSON.stringify(changed));
  assert.throws(() => publishCatalog(f.root, 'local', 'http://localhost:8080/v1', [f.model('fixture-b')]), /were edited/);
  assert.throws(() => f.install({ uninstall: true }), /Generated Juiced models/);
  assert.ok(existsSync(join(f.root, 'extensions', 'pi-t3-agent', 'index.ts')));
  changed.providers.local.models[0].contextWindow = 16384;
  writeFileSync(join(f.root, 'models.json'), JSON.stringify(changed));
  f.install({ uninstall: true });
  assert.equal(f.models().providers.local, undefined);
});

test('setup and discovery share an exclusive lock', t => {
  const f = fixture(t);
  withProfileLock(f.root, () => assert.throws(() => publishCatalog(f.root, 'local', 'http://localhost:8080/v1', []), /busy/));
  assert.equal(existsSync(join(f.root, '.pi-t3-agent.lock')), false);
  publishCatalog(f.root, 'local', 'http://localhost:8080/v1', []);
});

test('upgrades retire unchanged managed source files from the previous manifest', t => {
  const f = fixture(t), manifestPath = join(f.root, 'pi-t3-agent-install.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = 1;
  const oldPath = join(f.root, 'extensions', 'pi-t3-agent', 'tool-loadout.ts');
  const source = '// Retired fixture source'; writeFileSync(oldPath, source);
  manifest.files.push({ path: oldPath, hash: createHash('sha256').update(source).digest('hex') });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  f.install();
  assert.equal(existsSync(oldPath), false);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).version, 2);
});
