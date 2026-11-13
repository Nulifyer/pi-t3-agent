// Keep `providers.<id>.models` in models.json equal to what the model host serves.
//
// models.json is the one place Pi reads models from in every launch mode, including the
// extension-free helpers T3 Code uses for titles and commit messages. Everything else in the
// provider entry (base URL, key, modelOverrides) belongs to the user and is left alone.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { discover, toPiModels } from './catalog.mjs';
import { loadConfig, readJson, STATE_FILE, writeFileAtomic, writeJsonAtomic } from './config.mjs';

export const MODELS_FILE = 'models.json';

/** Pi's `apiKey` syntax: a literal, `$NAME` or `${NAME}` (`$$` and `$!` escape), or `!command`. */
export function resolveApiKey(value, env = process.env) {
  if (typeof value !== 'string' || value === '') return undefined;
  if (value.startsWith('!')) {
    return execSync(value.slice(1), { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  }
  const resolved = value.replace(/\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, token, braced, bare) => (token === '$' || token === '!' ? token : env[braced ?? bare] ?? ''));
  return resolved || undefined;
}

/** Replace the provider's model list. Returns whether the file changed. */
export function applyCatalog(directory, providerId, models) {
  const path = join(directory, MODELS_FILE);
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : '{}');
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = read();
    const document = JSON.parse(text);
    const provider = document.providers?.[providerId];
    if (!provider) throw new Error(`Provider "${providerId}" is missing from models.json. Run setup again.`);
    if (isDeepStrictEqual(provider.models ?? [], models)) return false;
    provider.models = models;
    // An edit made while this merge ran wins: start again from the new text.
    if (read() !== text) continue;
    writeFileAtomic(path, JSON.stringify(document, null, 2) + '\n');
    return true;
  }
  throw new Error('models.json kept changing during the catalog update.');
}

function describe(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `The model host did not answer within ${timeoutMs / 1000} s.`;
  if (error?.name === 'DiscoveryError') return error.message;
  if (error instanceof SyntaxError) return 'models.json is not valid JSON.';
  // fetch() failures can quote the endpoint; report only the cause code.
  if (error instanceof TypeError) return `The model host is unreachable${error.cause?.code ? ` (${error.cause.code})` : ''}.`;
  return String(error?.message ?? error);
}

/**
 * Refresh the catalog when it is older than `refreshSeconds`.
 * Never throws: on failure the previous models stay in place and `state.error` says why.
 * Status: "synced" (asked the host), "fresh" (recent enough), "stale" (last attempt failed),
 * "disabled" or "unconfigured".
 */
export async function syncCatalog(directory, { force = false, timeoutMs = 5000, env = process.env } = {}) {
  let config;
  let state = {};
  const statePath = join(directory, STATE_FILE);
  try {
    config = loadConfig(directory);
    state = readJson(statePath, {});
  } catch { /* A damaged state file is rewritten below; a damaged config is reported as unconfigured. */ }
  if (!config) return { status: 'unconfigured', state };
  if (config.discovery === 'off' || (!force && !(config.refreshSeconds > 0))) return { status: 'disabled', state };
  const now = Date.now();
  if (!force && now - (state.lastAttempt ?? 0) < config.refreshSeconds * 1000) {
    return { status: state.error ? 'stale' : 'fresh', state };
  }
  try {
    const provider = readJson(join(directory, MODELS_FILE), {}).providers?.[config.provider];
    if (!provider?.baseUrl) return { status: 'unconfigured', state };
    // Claim this attempt first so parallel Pi processes do not all ask the host at once.
    writeJsonAtomic(statePath, { ...state, lastAttempt: now });
    const found = await discover({
      baseUrl: provider.baseUrl,
      apiKey: resolveApiKey(provider.apiKey, env),
      mode: config.discovery,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const models = toPiModels(found.models, config);
    const changed = applyCatalog(directory, config.provider, models);
    const estimated = found.models.filter((model) => model.estimated).map((model) => model.id);
    state = { lastAttempt: now, lastSuccess: now, source: found.source, count: models.length, ...(estimated.length ? { estimated } : {}) };
    writeJsonAtomic(statePath, state);
    return { status: 'synced', changed, state };
  } catch (error) {
    state = { ...state, lastAttempt: now, error: describe(error, timeoutMs) };
    try { writeJsonAtomic(statePath, state); } catch { /* Reported through the return value. */ }
    return { status: 'stale', state };
  }
}
