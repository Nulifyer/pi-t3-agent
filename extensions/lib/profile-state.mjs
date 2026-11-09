import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const catalogFilename = 'pi-t3-agent-catalog.json';
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const equal = isDeepStrictEqual;

export function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, json(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function withProfileLock(directory, operation) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, '.pi-t3-agent.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  try { writeFileSync(path, json(owner), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Unknown locks stay intact. */ }
    let stale = false;
    if (Number.isSafeInteger(previous?.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); } catch (cause) { stale = cause.code === 'ESRCH'; }
    }
    if (!stale) throw new Error('Pi setup or catalog refresh is busy. Retry shortly.');
    unlinkSync(path);
    return withProfileLock(directory, operation);
  }
  try { return operation(); }
  finally {
    if (existsSync(path) && readFileSync(path, 'utf8') === json(owner)) unlinkSync(path);
  }
}

export function readCatalog(directory, provider, baseUrl) {
  const path = join(directory, catalogFilename);
  if (!existsSync(path)) return undefined;
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  if (snapshot.version !== 1 || snapshot.provider !== provider || !Array.isArray(snapshot.models))
    throw new Error('Invalid generated Juiced catalog. Preserve the file before retrying.');
  return snapshot.baseUrl === baseUrl ? snapshot : undefined;
}

export function nativeModels(models) {
  return models.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model);
}

export function publishCatalog(directory, provider, baseUrl, models, fetchedAt = Date.now()) {
  return withProfileLock(directory, () => {
    const path = join(directory, 'models.json');
    const contents = readFileSync(path, 'utf8');
    const document = JSON.parse(contents);
    const configured = document.providers?.[provider];
    if (!configured || configured.baseUrl?.replace(/\/+$/, '') !== baseUrl)
      throw new Error('Juiced configuration changed during discovery. Reload resources.');
    const previous = readCatalog(directory, provider, baseUrl);
    if (previous && !equal(configured.models ?? [], previous.models))
      throw new Error('Generated Juiced models were edited. Use modelOverrides for preferences.');
    if (!previous && configured.models?.length)
      throw new Error('Refusing to replace models without a generated catalog. Reinstall the setup.');
    if (previous?.fetchedAt > fetchedAt) return previous;
    const snapshot = { version: 1, provider, baseUrl, fetchedAt, models: nativeModels(models) };
    const original = structuredClone(document);
    let changed = false;
    try {
      if (!equal(configured.models, snapshot.models)) {
        configured.models = snapshot.models;
        if (readFileSync(path, 'utf8') !== contents) throw new Error('Model preferences changed during discovery. Retry the refresh.');
        atomicJson(path, document);
        changed = true;
      }
      atomicJson(join(directory, catalogFilename), snapshot);
    } catch (error) {
      if (changed && readFileSync(path, 'utf8') === json(document)) atomicJson(path, original);
      throw error;
    }
    return snapshot;
  });
}
