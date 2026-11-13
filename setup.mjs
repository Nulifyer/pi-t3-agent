#!/usr/bin/env node
// One-step setup: points Pi at a model host, registers this checkout as a Pi package, enables Pi in T3 Code.
// Re-run it after changing options; it converges on the described state.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_FILE, DEFAULTS, defaultAgentDir, readJson, STATE_FILE, writeJsonAtomic } from './lib/config.mjs';
import { MODELS_FILE, syncCatalog } from './lib/sync.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MINIMUM_PI = '1.5.0';
const FLAGS = new Set(['help', 'remove', 'status', 'no-t3', 'trust-projects']);
const VALUES = new Set(['base-url', 'api-key', 'api-key-env', 'provider', 'default-model', 'agent-dir', 'pi-bin', 't3-settings', 'discovery', 'refresh-seconds', 'compact-below']);
const LISTS = new Set(['reasoning', 'vision', 'exclude']);
// Files and folders earlier releases copied into the profile. This release loads from the checkout instead.
const LEGACY = ['extensions/pi-t3-agent', 'extensions/lib/command-sessions.ts', 'extensions/lib/juiced-catalog.ts', 'extensions/agent-tools.ts',
  'extensions/ask-user.ts', 'extensions/juiced-provider.ts', 'extensions/tool-loadout.ts', 'extensions/lemonade-tool-loadout.ts',
  'pi-t3-agent-install.json', 'pi-t3-agent-catalog.json', '.pi-t3-agent.lock'];
const LEGACY_LAUNCH_ARGS = '--tools +grep,+find,+ls,+tool_search';
const LAUNCHER = 'pi-t3-agent.cmd';
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

const HELP = `Set up Pi and T3 Code for a self-hosted model host.

  node setup.mjs --base-url URL [options]

  --base-url URL          OpenAI-compatible API base, usually ending in /v1 (kept from the last run if omitted)
  --api-key-env NAME      Read the API key from this environment variable (set it in T3 Code's Pi provider settings)
  --api-key KEY           Store the key itself in models.json (readable only by you)
  --provider ID           Provider name shown in T3 Code (default: ${DEFAULTS.provider})
  --default-model ID      Model for "Pi default" (default: keep a valid one, else the first discovered)
  --reasoning PATTERN     Model IDs that can think but are not labelled so by the host; * is a wildcard; repeatable
  --vision PATTERN        Model IDs that accept images but are not labelled so by the host; repeatable
  --exclude PATTERN       Model IDs to hide; repeatable
  --discovery MODE        auto (default), juiced, openai, or off
  --refresh-seconds N     Minimum time between catalog requests (default: ${DEFAULTS.refreshSeconds})
  --compact-below N       Context size under which the compact tool loadout applies (default: ${DEFAULTS.compactBelow})
  --trust-projects        Let Pi load project skills, settings and extensions without asking
  --agent-dir PATH        Pi profile (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --pi-bin PATH           Pi executable (default: pi)
  --t3-settings PATH      T3 Code settings file (default: ~/.t3/userdata/settings.json)
  --no-t3                 Leave T3 Code settings alone
  --status                Show the current setup without changing anything
  --remove                Unregister the package and delete its configuration
`;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || !(FLAGS.has(name) || VALUES.has(name) || LISTS.has(name))) throw new Error(`Unknown option: ${argv[index]}`);
    if (FLAGS.has(name)) { options[name] = true; continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    if (LISTS.has(name)) (options[name] ??= []).push(value);
    else options[name] = value;
  }
  return options;
}

/**
 * The file to start for a Pi command. Windows cannot start a bare name: Pi is installed as launcher
 * files, and only a shell picks one. PowerShell picks `pi.ps1`, which neither Node nor T3 Code can
 * start, so typing `pi` works there while a program that starts `pi` fails. This finds the `.exe`
 * or `.cmd` launcher instead.
 */
export function findPi(binary, { platform = process.platform, env = process.env, agent = defaultAgentDir() } = {}) {
  if (platform !== 'win32') return binary;
  const names = /\.(exe|cmd|bat)$/i.test(binary) ? [binary] : ['.exe', '.cmd', '.bat'].map((extension) => binary.replace(/\.ps1$/i, '') + extension);
  if (/[\\/]/.test(binary)) return names.map((name) => resolve(name)).find(isFile) ?? binary;
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  // After PATH: where Pi's installer and npm put the launchers, for a PATH that predates the install.
  const directories = [...path.split(';'), join(agent, 'bin'), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])]
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const directory of directories) {
    const found = names.map((name) => join(directory, name)).find(isFile);
    if (found) return found;
  }
  return binary;
}

/**
 * On Windows, the launcher T3 Code is given. Pi's own `pi.cmd` starts `node` by name, so it fails in
 * any program whose `PATH` lacks Node.js, with `"node" is not recognized`. This writes a launcher into
 * the profile that starts Pi's program with the full path of the Node.js running setup, and falls
 * back to `node` if that file is gone. Returns `found` unchanged when the install is not laid out the
 * way npm or Pi's installer lays it out, or when setup is not running under Node.js.
 */
export function ownLauncher(found, agent, { platform = process.platform, node = process.versions.bun ? undefined : process.execPath } = {}) {
  if (platform !== 'win32' || !node || !/\.(cmd|bat)$/i.test(found)) return found;
  const directory = dirname(found);
  const packaged = join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const bin = readJson(join(packaged, 'package.json'), {}).bin;
  const program = typeof bin === 'string' ? bin : bin?.pi;
  // Pi's installer puts pi-launcher.js beside pi.cmd; npm puts the package beside it.
  const entry = [join(directory, 'pi-launcher.js'), ...(typeof program === 'string' ? [join(packaged, program)] : [])].find(isFile);
  const launcher = join(agent, LAUNCHER);
  // cmd.exe reads a batch file in the console's code page and expands % and ^, so only plain paths are written.
  if (!entry || [node, entry, launcher].some((path) => /[^\x20-\x7e]|["%&|<>^!]/.test(path))) return found;
  mkdirSync(agent, { recursive: true });
  writeFileSync(launcher, ['@ECHO off', 'SETLOCAL', `SET "node=${node}"`, 'IF NOT EXIST "%node%" SET "node=node"', `"%node%" "${entry}" %*`, ''].join('\r\n'));
  return launcher;
}

export function piVersion(binary, { env = process.env } = {}) {
  // A .cmd launcher runs through cmd.exe, which needs the path quoted when it contains spaces.
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  if (shim && /["%&|<>^\r\n]/.test(binary)) throw new Error('Unsafe Pi path.');
  // A minute: virus scanning on a managed laptop can make the first start of Pi slow.
  const options = { encoding: 'utf8', timeout: 60000, windowsHide: true, env };
  const result = shim ? spawnSync(`"${binary}" --version`, { ...options, shell: true }) : spawnSync(binary, ['--version'], options);
  const version = result.stdout?.trim().match(/\d+\.\d+\.\d+/)?.[0];
  if (result.error || result.status !== 0 || !version) {
    // The reason is what tells a missing Pi from a broken launcher, a timeout or a missing Node.js.
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split(/\r?\n/).slice(-3).join(' | ');
    const reason = result.error?.message ?? [`exit code ${result.status}`, output].filter(Boolean).join(': ');
    throw new Error(`Cannot run "${binary}": ${reason}. Install Pi first, or pass --pi-bin.` + (process.platform === 'win32'
      ? ' On Windows, pass the full path of pi.cmd or pi.exe; a pi.ps1 script cannot be started by T3 Code.' : ''));
  }
  const older = version.split('.').map(Number).reduce((result, part, index) => result || part - Number(MINIMUM_PI.split('.')[index]), 0) < 0;
  if (older) throw new Error(`Pi ${version} is too old. This package needs Pi ${MINIMUM_PI} or newer.`);
  return version;
}

const samePath = (base, entry) => {
  const source = typeof entry === 'string' ? entry : entry?.source;
  return typeof source === 'string' && !/^(npm|git|https?):/.test(source) && resolve(isAbsolute(source) ? source : join(base, source)) === ROOT;
};

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${name} must be a whole number`);
  return number;
}

function t3Path(options) {
  return options['t3-settings'] ?? join(homedir(), '.t3', 'userdata', 'settings.json');
}

export async function setup(options, { log = console.log, checkPi = piVersion, platform = process.platform, env = process.env, node } = {}) {
  const agent = resolve(options['agent-dir'] ?? defaultAgentDir());
  const paths = { config: join(agent, CONFIG_FILE), state: join(agent, STATE_FILE), models: join(agent, MODELS_FILE), settings: join(agent, 'settings.json') };
  const saved = readJson(paths.config, {});
  const settings = readJson(paths.settings, {});
  const models = readJson(paths.models, {});
  const providerId = options.provider ?? saved.provider ?? DEFAULTS.provider;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(providerId)) throw new Error('--provider must start with a letter and use only letters, digits, - and _');

  if (options.status) {
    const provider = models.providers?.[providerId];
    const state = readJson(paths.state, {});
    const t3 = options['no-t3'] || !existsSync(t3Path(options)) ? undefined : readJson(t3Path(options), {}).providerInstances?.pi;
    log(`Pi profile:   ${agent}`);
    log(`Package:      ${(settings.packages ?? []).some((entry) => samePath(agent, entry)) ? 'registered' : 'not registered'}`);
    log(`Provider:     ${providerId} (${provider?.baseUrl ? `${(provider.models ?? []).length} models` : 'no base URL'})`);
    log(`Last sync:    ${state.lastSuccess ? new Date(state.lastSuccess).toISOString() : 'never'}${state.error ? ` (${state.error})` : ''}`);
    log(`T3 Code:      ${t3 === undefined ? 'not checked' : t3.enabled ? 'Pi enabled' : 'Pi not enabled'}`);
    return { status: true };
  }

  if (options.remove) {
    if (Array.isArray(settings.packages)) {
      settings.packages = settings.packages.filter((entry) => !samePath(agent, entry));
      writeJsonAtomic(paths.settings, settings);
    }
    rmSync(paths.config, { force: true });
    rmSync(paths.state, { force: true });
    log('Removed the package registration and its configuration.');
    log(`The "${providerId}" provider in models.json was kept, so its last known models still work.`);
    return { removed: true };
  }

  const found = findPi(options['pi-bin'] ?? 'pi', { platform, env, agent });
  const binary = ownLauncher(found, agent, { platform, ...(node ? { node } : {}) });
  const version = checkPi(binary);

  // --- configuration this package owns
  const config = { ...saved };
  delete config.commandShell; // from an earlier release
  config.provider = providerId;
  if (options.discovery) config.discovery = options.discovery;
  if (config.discovery !== undefined && !['auto', 'juiced', 'openai', 'off'].includes(config.discovery)) throw new Error('--discovery must be auto, juiced, openai or off');
  if (options['refresh-seconds']) config.refreshSeconds = positiveInteger(options['refresh-seconds'], 'refresh-seconds');
  if (options['compact-below']) config.compactBelow = positiveInteger(options['compact-below'], 'compact-below');
  for (const list of LISTS) if (options[list]) config[list] = [...new Set([...(config[list] ?? []), ...options[list]])];

  // --- the provider entry Pi reads
  const provider = { ...(models.providers?.[providerId] ?? {}) };
  if (options['base-url']) {
    const url = new URL(options['base-url']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--base-url must be a plain http(s) URL');
    provider.baseUrl = options['base-url'].replace(/\/+$/, '');
  }
  if (!provider.baseUrl) throw new Error('Pass --base-url with your model host\'s API base, for example https://ai.example.com/v1');
  if (options['api-key'] && options['api-key-env']) throw new Error('Pass --api-key or --api-key-env, not both');
  if (options['api-key-env']) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options['api-key-env'])) throw new Error('--api-key-env must be an environment variable name');
    provider.apiKey = '$' + options['api-key-env'];
  } else if (options['api-key']) provider.apiKey = options['api-key'].replace(/\$/g, '$$$$').replace(/^!/, '$$!'); // escape Pi's $NAME and !command syntax
  provider.apiKey ??= 'local';
  provider.api ??= 'openai-completions';
  provider.models ??= [];
  // The earlier release had users mark thinking models under modelOverrides, and wrote image support
  // into its generated list from host labels the current Juiced service no longer sends. Carry both over.
  for (const [id, override] of Object.entries(provider.modelOverrides ?? {})) {
    if (override?.reasoning === true && !(config.reasoning ?? []).includes(id)) (config.reasoning ??= []).push(id);
  }
  if (existsSync(join(agent, 'pi-t3-agent-install.json'))) {
    for (const model of provider.models) {
      if (model?.input?.includes?.('image') && !(config.vision ?? []).includes(model.id)) (config.vision ??= []).push(model.id);
    }
  }

  // --- keep what is about to change, and clear files from earlier releases
  const backup = join(agent, 'backups', 'pi-t3-agent', new Date().toISOString().replace(/[:.]/g, '-'));
  const keep = (path) => {
    if (!existsSync(path)) return;
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    cpSync(path, join(backup, path.slice(agent.length + 1).replace(/[\\/]/g, '__')), { recursive: true });
  };
  for (const path of [paths.config, paths.models, paths.settings]) keep(path);
  const retired = [];
  for (const name of LEGACY) {
    const path = join(agent, name);
    if (!existsSync(path)) continue;
    keep(path);
    rmSync(path, { recursive: true, force: true });
    retired.push(name);
  }
  const legacyLib = join(agent, 'extensions', 'lib');
  if (existsSync(legacyLib) && readdirSync(legacyLib).length === 0) rmdirSync(legacyLib);

  writeJsonAtomic(paths.config, config);
  writeJsonAtomic(paths.models, { ...models, providers: { ...models.providers, [providerId]: provider } });

  // --- first sync: proves the connection and fills the model list before T3 Code looks
  const sync = await syncCatalog(agent, { force: true, timeoutMs: 15000 });
  const discovered = readJson(paths.models, {}).providers?.[providerId]?.models ?? [];

  // --- Pi settings
  settings.packages = [...(Array.isArray(settings.packages) ? settings.packages : []).filter((entry) => !samePath(agent, entry)), ROOT];
  // Dedicated search tools are read-only, so T3 Code's supervised mode runs them without a prompt.
  settings.defaultTools = [...new Set([...(Array.isArray(settings.defaultTools) ? settings.defaultTools : []), '+grep', '+find', '+ls'])];
  if (options['trust-projects']) settings.defaultProjectTrust = 'always';
  const wanted = options['default-model'];
  if (wanted && discovered.length > 0 && !discovered.some((model) => model.id === wanted)) throw new Error(`--default-model ${wanted} is not served by the host`);
  const defaultIsOurs = settings.defaultProvider === providerId && discovered.some((model) => model.id === settings.defaultModel);
  if (wanted || (!defaultIsOurs && discovered.length > 0 && (settings.defaultProvider === undefined || settings.defaultProvider === providerId))) {
    settings.defaultProvider = providerId;
    settings.defaultModel = wanted ?? discovered[0].id;
  }
  writeJsonAtomic(paths.settings, settings);

  // --- T3 Code: it watches this file and applies the change without a restart
  let t3 = 'skipped';
  const t3File = t3Path(options);
  if (!options['no-t3'] && existsSync(t3File)) {
    const document = readJson(t3File, {});
    const before = JSON.stringify(document);
    const instance = (document.providerInstances ??= {}).pi ??= {};
    if (instance.driver && instance.driver !== 'pi') throw new Error('T3 Code\'s "pi" provider instance uses another driver. Enable Pi in T3 Code settings yourself and pass --no-t3.');
    instance.driver = 'pi';
    instance.enabled = true;
    instance.config ??= {};
    // On Windows a bare `pi` depends on the PATH T3 Code started with; the launcher's full path does not.
    // A path an earlier run of setup wrote is replaced too.
    const current = instance.config.binaryPath ?? '';
    const replaceable = platform === 'win32' && (/^pi(\.(cmd|exe|ps1))?$/i.test(current) || current.toLowerCase() === found.toLowerCase());
    if (options['pi-bin'] || !current || replaceable) instance.config.binaryPath = binary;
    if (instance.config.launchArgs === LEGACY_LAUNCH_ARGS) instance.config.launchArgs = '';
    const environment = (Array.isArray(instance.environment) ? instance.environment : []).filter((entry) => entry?.name !== 'PI_CODING_AGENT_DIR');
    // Only a non-default profile needs to be named; Pi finds the default one itself.
    if (agent !== resolve(join(homedir(), '.pi', 'agent'))) environment.push({ name: 'PI_CODING_AGENT_DIR', value: agent, sensitive: false });
    if (environment.length > 0) instance.environment = environment; else delete instance.environment;
    if (JSON.stringify(document) !== before) {
      cpSync(t3File, t3File + '.pi-t3-agent.bak');
      writeJsonAtomic(t3File, document);
      t3 = 'updated';
    } else t3 = 'unchanged';
  } else if (!options['no-t3']) t3 = 'not found';

  log(`Pi ${version}, profile ${agent}`);
  if (retired.length) log(`Retired files from an earlier release: ${retired.join(', ')}`);
  if (existsSync(backup)) log(`Previous files saved in ${backup}`);
  if (sync.status === 'synced') log(`Model host answered: ${discovered.length} chat model${discovered.length === 1 ? '' : 's'}${discovered.length ? ` (${discovered.map((model) => model.id).join(', ')})` : ''}.`);
  else log(`Model host check failed: ${sync.state?.error ?? sync.status}. Setup is saved; models sync when the host answers.`);
  if (sync.state?.estimated?.length) log(`No context size reported for ${sync.state.estimated.join(', ')}. Set contextWindow under modelOverrides in models.json.`);
  if (/^\$[A-Za-z_]/.test(provider.apiKey)) log(`API key: add ${provider.apiKey.slice(1)} to the Pi provider's environment in T3 Code settings and mark it sensitive.`);
  log(t3 === 'updated' ? 'T3 Code: Pi enabled. Open Settings > Providers and refresh Pi to see the models.'
    : t3 === 'unchanged' ? 'T3 Code: Pi was already enabled.'
    : t3 === 'not found' ? 'T3 Code settings not found. Start T3 Code once and re-run, or enable Pi in its settings.'
    : 'T3 Code settings left alone. Enable Pi under Settings > Providers.');
  return { agent, version, sync: sync.status, models: discovered.map((model) => model.id), t3, retired };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await setup(options);
  } catch (error) {
    // A JSON parse error can quote file contents, which may include a key.
    console.error(error instanceof SyntaxError ? 'A settings file is not valid JSON. Fix it and run setup again.' : `Setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
