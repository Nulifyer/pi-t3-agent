#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPackage = 'npm:pi-web-access@0.46.0';
const launchArgs = '--tools +grep,+find,+ls,+tool_search';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flags = new Set(['help', 'dry-run', 'uninstall', 'set-default', 'configure-t3', 'reasoning', 'vision']);
const values = new Set(['agent-dir', 'base-url', 'provider', 'model', 'discovery', 'search-url', 'allow-fetch-range',
  'api-key-env', 't3-settings', 'pi-bin', 'command-shell', 'context-window', 'max-tokens']);

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !values.has(key))) throw new Error('Unknown option: ' + args[i]);
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
      if (key === 'allow-fetch-range') (options[key] ??= []).push(value);
      else options[key] = value;
    }
  }
  return options;
}

function read(path) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular file: ' + path);
  return readFileSync(path, 'utf8');
}
function objectFile(path) {
  const text = read(path);
  const value = text === null ? {} : JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object: ' + path);
  return value;
}
function checkParents(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Refusing a symlink in install destination: ' + p);
    if (dirname(p) === p) break;
  }
}
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function url(value, name) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(name + ' must be an HTTP(S) URL without credentials, query, or fragment');
  return value.replace(/\/+$/, '');
}
function positive(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(name + ' must be a positive integer');
  return number;
}
function getAt(object, keys) { return keys.reduce((value, key) => value?.[key], object); }
function setAt(object, keys, value) {
  let parent = object;
  for (const key of keys.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {};
    if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) throw new Error('Invalid settings object at ' + key);
    parent = parent[key];
  }
  if (value === undefined) delete parent[keys.at(-1)];
  else parent[keys.at(-1)] = clone(value);
}
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
function checkPi(binary) {
  // Windows npm installs supply pi.cmd. cmd.exe is needed only for that shim;
  // reject shell metacharacters before using it. Normal executables use no shell.
  const shim = process.platform === 'win32' && /\.cmd$/i.test(binary);
  if (shim && /["%&|<>^\r\n]/.test(binary)) throw new Error('Unsafe Pi shim path');
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000, shell: shim, windowsHide: true });
  const version = result.stdout?.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (result.error || result.status !== 0 || !version) throw new Error('Cannot run Pi. Install Pi first or provide --pi-bin.');
  if (Number(version[1]) !== 1 || Number(version[2]) < 5) throw new Error('This release requires Pi 1.5.x or newer in the 1.x series.');
  return version[0];
}

export function installProfile(options, dependencies = {}) {
  const agent = resolve(options['agent-dir'] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
  const manifestPath = join(agent, 'pi-t3-agent-install.json');
  const old = read(manifestPath) === null ? null : objectFile(manifestPath);
  if (old && old.version !== 1) throw new Error('Unsupported install manifest version');
  if (options.uninstall) return uninstall(agent, old, manifestPath, options['dry-run']);
  const windowsPi = process.platform === 'win32' ? spawnSync('where.exe', ['pi'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/).find((path) => /\.(exe|cmd)$/i.test(path)) : undefined;
  const binary = options['pi-bin'] ?? old?.piBinary ?? windowsPi ?? 'pi';
  const piVersion = (dependencies.checkPi ?? checkPi)(binary);
  const previousConfig = objectFile(join(agent, 'pi-t3-agent.json'));
  const config = { ...previousConfig, commandShell: options['command-shell'] ?? previousConfig.commandShell ?? (process.platform === 'win32' ? 'powershell' : 'bash') };
  if (!['bash', 'powershell'].includes(config.commandShell)) throw new Error('--command-shell must be bash or powershell');
  if (config.commandShell === 'powershell' && process.platform !== 'win32') throw new Error('PowerShell command sessions require native Windows');
  if (options.provider) config.provider = options.provider;
  if (options['base-url'] && !config.provider) config.provider = 'local';
  if (config.provider && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(config.provider)) throw new Error('Invalid provider ID');
  if (options.discovery) config.discovery = options.discovery;
  config.discovery ??= 'none';
  if (!['none', 'juiced'].includes(config.discovery)) throw new Error('--discovery must be none or juiced');
  if (options['api-key-env']) config.apiKeyEnv = options['api-key-env'];
  if (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('Invalid API key environment variable name');
  if (old && previousConfig.provider !== config.provider) throw new Error('Uninstall before changing the managed provider ID');
  if (config.discovery === 'juiced' && !config.provider) throw new Error('Juiced discovery requires --base-url');
  if (!config.provider && (options.model || options['set-default'] || options['api-key-env'])) throw new Error('Model options require --base-url or an existing managed provider');
  const changes = new Map();
  const fields = clone(old?.fields ?? []);
  const managed = clone(old?.files ?? []);
  function stage(path, content) {
    checkParents(path);
    const before = read(path);
    if (before !== content) changes.set(path, { before, after: content });
  }
  function ownedFile(path, content) {
    const prior = managed.find((entry) => entry.path === path);
    if (prior && hash(read(path) ?? '') !== prior.hash) throw new Error('Managed file was edited; preserve it before reinstalling: ' + path);
    if (!prior && read(path) !== null) throw new Error('Install target already exists: ' + path);
    stage(path, content);
    if (prior) prior.hash = hash(content);
    else managed.push({ path, hash: hash(content) });
  }
  const documents = new Map();
  function field(path, keys, value) {
    const document = documents.get(path) ?? objectFile(path);
    documents.set(path, document);
    const prior = fields.find((entry) => entry.path === path && equal(entry.keys, keys));
    const before = clone(getAt(document, keys));
    if (prior && !equal(before, prior.after)) throw new Error('Managed setting was edited; preserve it before reinstalling: ' + keys.join('.'));
    if (prior) prior.after = clone(value);
    else fields.push({ path, keys, ...(before === undefined ? {} : { before }), after: clone(value) });
    setAt(document, keys, value);
  }
  const settingsPath = join(agent, 'settings.json');
  const settings = objectFile(settingsPath);
  if (settings.defaultTools !== undefined && !Array.isArray(settings.defaultTools)) throw new Error('defaultTools must be an array');
  const defaults = [...new Set([...(settings.defaultTools ?? []), '+grep', '+find', '+ls', '+tool_search'])];
  field(settingsPath, ['defaultTools'], defaults);
  // An explicit old codemode-only setting would hide the direct tools.
  if (settings.codemode?.mode === 'only') field(settingsPath, ['codemode', 'mode'], 'on');
  if (config.provider) {
    const path = join(agent, 'models.json');
    const models = objectFile(path);
    const existing = models.providers?.[config.provider];
    const managedProvider = old?.fields.some((entry) => entry.path === path && equal(entry.keys, ['providers', config.provider]));
    if (existing && !managedProvider) throw new Error('Provider ID already exists. Choose another --provider to preserve it.');
    const provider = clone(existing ?? { api: 'openai-completions', apiKey: 'local' });
    if (options['base-url']) provider.baseUrl = url(options['base-url'], '--base-url');
    if (!provider.baseUrl) throw new Error('Configure the provider with --base-url');
    if (config.apiKeyEnv) provider.apiKey = '${' + config.apiKeyEnv + '}';
    if (config.discovery === 'juiced') {
      delete provider.models;
      if (options.model && (options.reasoning || options.vision)) {
        provider.modelOverrides ??= {};
        provider.modelOverrides[options.model] = { ...(provider.modelOverrides[options.model] ?? {}),
          ...(options.reasoning ? { reasoning: true } : {}), ...(options.vision ? { input: ['text', 'image'] } : {}) };
      }
    } else if (options.model) {
      const contextWindow = positive(options['context-window'], 65536, '--context-window');
      const maxTokens = positive(options['max-tokens'], Math.min(8192, Math.floor(contextWindow / 2)), '--max-tokens');
      if (maxTokens >= contextWindow) throw new Error('--max-tokens must be smaller than --context-window');
      provider.models = [{ id: options.model, name: options.model, reasoning: !!options.reasoning,
        input: options.vision ? ['text', 'image'] : ['text'], contextWindow, maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' } }];
    } else if (!provider.models?.length) throw new Error('A compatible endpoint requires --model, or use --discovery juiced');
    field(path, ['providers', config.provider], provider);
    if (options['set-default']) {
      if (!options.model) throw new Error('--set-default requires --model');
      field(settingsPath, ['defaultProvider'], config.provider);
      field(settingsPath, ['defaultModel'], options.model);
    }
  }
  if (options['search-url']) {
    const packages = settings.packages ?? [];
    if (!Array.isArray(packages)) throw new Error('packages must be an array');
    const web = packages.filter((entry) => typeof entry === 'string' && /^npm:pi-web-access(?:@|$)/.test(entry));
    if (web.some((entry) => entry !== webPackage)) throw new Error('Another pi-web-access version is configured; reconcile it before installation.');
    field(settingsPath, ['packages'], [...new Set([...packages, webPackage])]);
    const searchPath = join(agent, 'web-search.json');
    const search = {
      provider: 'searxng', searxngBaseUrl: url(options['search-url'], '--search-url'), workflow: 'none',
      toolActivation: 'eager', toolExposure: 'direct', webSearch: { allowedProviders: ['searxng'] },
      fetchRouting: { providers: ['http'], allowRemoteHostedProviders: false }, image: { enabled: false },
      maxInlineContentChars: 8000, fetch: { allowedModes: ['readable', 'raw'], defaultMode: 'readable' }, autoOpenBrowser: false,
      ssrf: { allowRanges: options['allow-fetch-range'] ?? [] },
    };
    for (const [key, value] of Object.entries(search)) field(searchPath, [key], value);
  } else if (options['allow-fetch-range']) throw new Error('--allow-fetch-range requires --search-url');
  if (options['configure-t3'] || options['t3-settings']) {
    const path = resolve(options['t3-settings'] ?? join(homedir(), '.t3', 'userdata', 'settings.json'));
    if (!existsSync(path)) throw new Error('T3 settings were not found. Start T3 once or provide --t3-settings.');
    const t3 = objectFile(path);
    if (t3.providerInstances?.pi?.config?.launchArgs && t3.providerInstances.pi.config.launchArgs !== launchArgs)
      throw new Error('T3 Pi already has custom launch arguments. Merge the documented arguments manually.');
    field(path, ['providerInstances', 'pi', 'enabled'], true);
    field(path, ['providerInstances', 'pi', 'config', 'binaryPath'], binary);
    field(path, ['providerInstances', 'pi', 'config', 'launchArgs'], launchArgs);
    // A non-default agent directory must be configured in T3's provider
    // environment by the operator, since its environment schema is app-owned.
  }
  ownedFile(join(agent, 'pi-t3-agent.json'), json(config));
  for (const source of filesUnder(join(root, 'extensions'))) {
    ownedFile(join(agent, 'extensions', 'pi-t3-agent', relative(join(root, 'extensions'), source)), readFileSync(source, 'utf8'));
  }
  for (const [path, document] of documents) stage(path, json(document));
  const manifest = { version: 1, packageVersion: '0.1.0', piBinary: binary, files: managed, fields,
    backups: old?.backups ?? [] };
  if (options['dry-run']) return { dryRun: true, piVersion, filesChanged: changes.size, agentDir: agent };
  if (!changes.size) return { installed: true, piVersion, filesChanged: 0, agentDir: agent };
  const backup = join(agent, 'backups', 'pi-t3-agent', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  for (const path of [...changes.keys(), manifestPath, backup]) checkParents(path);
  // Check for edits since preflight before touching any destination.
  for (const [path, change] of changes) if (read(path) !== change.before) throw new Error('A file changed during preflight. Retry installation.');
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  let index = 0;
  for (const [path, change] of changes) {
    if (change.before !== null) atomicWrite(join(backup, String(index) + '.json'), json({ path, content: change.before }));
    index++;
  }
  if (old) atomicWrite(join(backup, 'manifest.json'), json(old));
  manifest.backups = [...manifest.backups, backup];
  const written = [];
  try {
    for (const [path, change] of changes) {
      atomicWrite(path, change.after);
      written.push(path);
    }
    atomicWrite(manifestPath, json(manifest));
  } catch (error) {
    for (const path of written.reverse()) {
      const change = changes.get(path);
      if (change.before === null) unlinkSync(path);
      else atomicWrite(path, change.before);
    }
    throw error;
  }
  return { installed: true, piVersion, filesChanged: changes.size, agentDir: agent, backup };
}

function uninstall(agent, manifest, manifestPath, dryRun) {
  if (!manifest) return { uninstalled: true, filesChanged: 0, agentDir: agent };
  const changes = new Map();
  const conflicts = [];
  for (const file of manifest.files) {
    checkParents(file.path);
    const current = read(file.path);
    if (current === null) continue;
    if (hash(current) !== file.hash) conflicts.push(file.path);
    else changes.set(file.path, null);
  }
  const documents = new Map();
  for (const field of [...manifest.fields].reverse()) {
    checkParents(field.path);
    const document = documents.get(field.path) ?? objectFile(field.path);
    documents.set(field.path, document);
    if (!equal(getAt(document, field.keys), field.after)) conflicts.push(field.keys.join('.'));
    else setAt(document, field.keys, field.before);
  }
  if (conflicts.length) throw new Error('Uninstall preserved edited settings/files. Reconcile these first: ' + conflicts.join(', '));
  for (const [path, document] of documents) changes.set(path, json(document));
  if (dryRun) return { dryRun: true, filesChanged: changes.size, agentDir: agent };
  checkParents(manifestPath);
  const originals = new Map([...changes.keys(), manifestPath].map((path) => [path, read(path)]));
  try {
    for (const [path, after] of changes) {
      if (after === null) unlinkSync(path);
      else atomicWrite(path, after);
    }
    unlinkSync(manifestPath);
  } catch (error) {
    for (const [path, content] of originals) if (content !== null) atomicWrite(path, content);
    throw error;
  }
  return { uninstalled: true, filesChanged: changes.size, agentDir: agent, backupsRetained: true };
}

const help = `pi-t3-agent installer (Pi must already be installed)

node scripts/install.mjs [options]
  --base-url URL           OpenAI-compatible API base, including /v1 when required
  --model ID               Exact model ID, required without Juiced discovery
  --provider ID            New provider ID (default: local)
  --discovery juiced       Discover enabled downloaded Juiced Chat models
  --api-key-env NAME       Read authentication from this environment variable
  --reasoning --vision     Opt in to capabilities for the supplied model
  --context-window N      Static model context (default: 65536)
  --max-tokens N          Static output limit (default: 8192, bounded by context)
  --set-default           Select the supplied provider/model for new sessions
  --search-url URL        Enable pinned SearXNG web tools
  --allow-fetch-range CIDR Allow direct fetch to a specific private proxy range
  --command-shell SHELL   bash or powershell (Windows default: powershell)
  --configure-t3          Merge the standard T3 Pi settings if its file exists
  --t3-settings PATH      Use this T3 settings file and configure Pi there
  --pi-bin PATH           Pi executable or Windows npm shim
  --agent-dir PATH        Pi profile (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  --dry-run               Validate and show counts without changing files
  --uninstall             Restore managed settings and remove unchanged files
  --help                  Show this help

Without endpoint options, installs tools while preserving your current providers.
Endpoints, credentials, histories, and T3 pairing data are never printed.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const result = installProfile(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.installed) console.log('Start a new Pi/T3 conversation or reload Pi resources. Existing processes were not restarted.');
    }
  } catch (error) {
    // JSON parse errors can quote configuration values. Keep those local values private.
    console.error(error instanceof SyntaxError ? 'Invalid JSON in a local settings file. Fix it before retrying.' : error.message);
    process.exitCode = 1;
  }
}
