// Profile files this package owns, and the small JSON helpers shared by setup and the extensions.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_FILE = 'pi-t3-agent.json';
export const STATE_FILE = 'pi-t3-agent.state.json';

export const DEFAULTS = Object.freeze({
  /** Provider ID in models.json whose `models` list this package keeps in sync. */
  provider: 'juiced',
  /** "auto" tries the Juiced catalog, then a plain OpenAI-compatible /models list. */
  discovery: 'auto',
  /** Minimum seconds between catalog requests, shared by every Pi process of the profile. 0 disables sync. */
  refreshSeconds: 30,
  /** Models with a smaller context window get the compact tool loadout. */
  compactBelow: 40000,
  /** Model ID patterns (`*` wildcard) that support thinking although the host does not say so. */
  reasoning: [],
  /** Model ID patterns that accept images although the host does not say so. */
  vision: [],
  /** Model ID patterns to leave out of the catalog. */
  exclude: [],
  /** Wake the agent when a background command exits. */
  notifyJobExit: true,
});

export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

/** Parsed JSON object, or `fallback` when the file does not exist. Invalid JSON throws. */
export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a JSON object in ${path}`);
  return value;
}

/** Write through a sibling temporary file so readers never see a partial document. */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeJsonAtomic(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

/** The saved configuration merged over the defaults, or undefined before setup has run. */
export function loadConfig(directory) {
  const saved = readJson(join(directory, CONFIG_FILE));
  return saved ? { ...DEFAULTS, ...saved } : undefined;
}

/** `*` matches any run of characters; everything else is literal and case-insensitive. */
export function matchesAny(patterns, value) {
  return (patterns ?? []).some((pattern) =>
    new RegExp('^' + String(pattern).split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(value));
}
