// End-to-end checks against the installed `pi` binary, launched the way T3 Code launches it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, t3Tools, until } from './helpers/harness.mjs';

const T3 = 'mcp__t3-code__';
const DIRECT = ['orchestrator_capabilities', 'delegate_task', 'task_status'].map((name) => T3 + name);
const systemText = (payload) => JSON.stringify(payload.messages.filter((message) => message.role === 'system' || message.role === 'developer'));
const skill = (directory, name, description) => {
  mkdirSync(join(directory, name), { recursive: true });
  writeFileSync(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
};

test('T3 tools are declared on demand and stay callable', { timeout: 90000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.client();
  f.host.reply = (_payload, index) => [
    { tool: 'tool_search', args: { query: 'read a thread' } },
    { tool: T3 + 't3_thread_read', args: { threadId: 'thread-1' } },
    { tool: T3 + 'preview_status' }, // never searched for: still shelved when called
  ][index] ?? { text: 'done' };
  await c.prompt('Read thread-1.');

  const [first, afterSearch, , afterDirectCall] = f.host.completions.map(f.declared);
  for (const name of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'tool_search', 'ask_user', 'background_job', ...DIRECT]) assert.ok(first.includes(name), `${name} declared`);
  assert.deepEqual(first.filter((name) => name.startsWith(T3)).sort(), [...DIRECT].sort());
  assert.ok(!first.includes('tool_shelf'));
  // The whole point: the catalog is not paid for on every request.
  const everything = JSON.stringify(t3Tools).length;
  assert.ok(JSON.stringify(f.host.completions[0].tools).length < everything / 3, 'first request carries a fraction of the catalog');
  assert.match(systemText(f.host.completions[0]), /tool_search/);
  assert.match(systemText(f.host.completions[0]), /T3_ORCHESTRATION_FIXTURE|T3 Code orchestration/, "T3 Code's own instructions are untouched");

  assert.match(c.toolResults('tool_search')[0].result.content[0].text, /t3_thread_read/);
  assert.ok(afterSearch.includes(T3 + 't3_thread_read'), 'a searched tool is declared on the next request');
  assert.equal(c.toolResults(T3 + 't3_thread_read')[0].isError, false);
  assert.equal(c.toolResults(T3 + 'preview_status')[0].isError, false, 'a shelved tool still executes');
  assert.ok(afterDirectCall.includes(T3 + 'preview_status'), 'and is declared once used');
  assert.deepEqual(f.host.mcpCalls.map((call) => call.name), ['t3_thread_read', 'preview_status']);

  // Loaded tools persist across turns, a resource reload, and a resumed session.
  await c.prompt('Again.');
  assert.ok(f.declared(f.host.completions.at(-1)).includes(T3 + 't3_thread_read'));
  assert.equal((await c.prompt('/pi-reload')).success, true);
  await c.prompt('After reload.');
  const afterReload = f.declared(f.host.completions.at(-1));
  assert.ok(afterReload.includes(T3 + 't3_thread_read') && afterReload.includes(T3 + 'preview_status'));
  assert.ok(!afterReload.includes(T3 + 'device_list'));
  const { sessionFile } = (await c.request('get_state')).data;
  assert.deepEqual(c.errors(), []);
  await c.close();

  const resumed = f.client({ args: ['--session', sessionFile] });
  await resumed.prompt('After resume.');
  const afterResume = f.declared(f.host.completions.at(-1));
  assert.ok(afterResume.includes(T3 + 't3_thread_read') && !afterResume.includes(T3 + 'device_list'));
  assert.deepEqual(resumed.errors(), []);
});

test('a small-context model gets the compact loadout until the model changes', { timeout: 90000 }, async (t) => {
  const f = await fixture({ models: [{ id: 'small', context: 16384 }, { id: 'big', context: 131072 }], setupOptions: { 'default-model': 'small' } });
  t.after(() => f.close());
  skill(join(f.paths.home, '.agents', 'skills'), 'fixture-skill', 'FIXTURE_SKILL_DESCRIPTION');
  const c = f.client();
  await c.prompt('Hello.');
  const small = f.host.completions.at(-1);
  assert.deepEqual(f.declared(small).sort(), ['ask_user', 'bash', 'edit', 'find', 'grep', 'ls', 'read', 'tool_search', 'write']);
  assert.doesNotMatch(systemText(small), /FIXTURE_SKILL_DESCRIPTION/);
  assert.match(systemText(small), /Skills are not listed/);
  // The user can still attach the skill; Pi expands it from the command list.
  assert.ok((await c.request('get_commands')).data.commands.some((command) => command.name === 'skill:fixture-skill'));

  // Everything hidden remains one search away.
  f.host.reply = (_payload, index) => (index === 1 ? { tool: 'tool_search', args: { query: 'delegate task' } } : { text: 'done' });
  await c.prompt('Delegate this.');
  assert.ok(f.declared(f.host.completions.at(-1)).includes(T3 + 'delegate_task'));

  // Starting a background job brings its management tool along.
  f.host.reply = (_payload, index) => (index === 3 ? { tool: 'bash', args: { command: 'sleep 30', run_in_background: true } } : { text: 'done' });
  await c.prompt('Start a server.');
  assert.ok(f.declared(f.host.completions.at(-1)).includes('background_job'));

  assert.equal((await c.request('set_model', { provider: 'juiced', modelId: 'big' })).success, true);
  f.host.reply = () => ({ text: 'done' });
  await c.prompt('Hello again.');
  const big = f.host.completions.at(-1);
  for (const name of [...DIRECT, 'background_job']) assert.ok(f.declared(big).includes(name), `${name} declared for the larger model`);
  assert.match(systemText(big), /FIXTURE_SKILL_DESCRIPTION/);
  assert.deepEqual(c.errors(), []);
});

test("T3 Code's discovery probe and its extension-free helper both see the host's models", { timeout: 90000 }, async (t) => {
  const f = await fixture({ models: [{ id: 'coder', context: 65536, parallel: 2, thinking: 'on' }, { id: 'embedder', context: 8192, operations: ['embeddings'] }] });
  t.after(() => f.close());
  // Setup ran while only these two existed. A model added afterwards must appear without setup.
  f.host.models.push({ id: 'later', context: 32768, loaded: true, policy: 'hot' });
  await new Promise((resolve) => setTimeout(resolve, 1100)); // let the one-second refresh window pass
  const probe = f.client({ bridge: false, args: ['--no-session', '--offline'] });
  const listed = (await probe.request('get_available_models')).data.models.filter((model) => model.provider === 'juiced');
  assert.deepEqual(listed.map((model) => model.id), ['later', 'coder'], 'chat models only, always-loaded first');
  const coder = listed.find((model) => model.id === 'coder');
  assert.equal(coder.contextWindow, 65536);
  assert.equal(coder.reasoning, true);
  assert.deepEqual(Object.entries(coder.thinkingLevelMap).filter(([, value]) => value !== null).map(([level]) => level), ['off', 'medium']);
  await probe.close();

  // Titles and commit messages run with extensions and tools off; they can only use models.json.
  const helper = f.client({ bridge: false, args: ['--no-session', '--offline', '--no-extensions', '--no-tools'] });
  assert.equal((await helper.request('set_model', { provider: 'juiced', modelId: 'later' })).success, true);
  await helper.prompt('Write a title.');
  assert.equal(f.host.completions.at(-1).model, 'later');
  assert.equal(f.host.completions.at(-1).tools, undefined);
});

test('a running session follows catalog changes and survives a host outage', { timeout: 90000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.client();
  const ids = async () => (await c.request('get_available_models')).data.models.filter((model) => model.provider === 'juiced').map((model) => model.id);
  assert.deepEqual(await ids(), ['big']);

  // Another Pi process (here: T3 Code's probe) discovers a new model and rewrites models.json.
  f.host.models = [{ id: 'big', context: 131072 }, { id: 'new', context: 65536 }];
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const probe = f.client({ bridge: false, args: ['--no-session', '--offline'] });
  await probe.request('get_state');
  await probe.close();
  await until(async () => (await ids()).includes('new'));
  assert.equal((await c.request('set_model', { provider: 'juiced', modelId: 'new' })).success, true, 'selectable without restarting the thread');

  f.host.outage = true;
  await c.prompt('/pi-sync');
  assert.match(c.notices().at(-1), /last known models/);
  assert.deepEqual(await ids(), ['big', 'new'], 'an outage keeps the last catalog');
  assert.ok(c.events.some((event) => event.type === 'extension_ui_request' && event.method === 'setStatus' && /unreachable/.test(event.statusText ?? '')));

  f.host.outage = false;
  f.host.models = [{ id: 'new', context: 65536 }];
  await c.prompt('/pi-sync');
  assert.match(c.notices().at(-1), /1 model from the Juiced catalog/);
  assert.deepEqual(await ids(), ['new'], 'a model the host no longer serves is removed');
  assert.deepEqual(JSON.parse(readFileSync(join(f.paths.profile, 'models.json'), 'utf8')).providers.juiced.models.map((model) => model.id), ['new']);
  assert.deepEqual(c.errors(), []);
});

test('background commands return at once, report their exit, and can be read or stopped', { timeout: 90000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.client();
  // Pi's bash tool is the default shell tool on every platform (Git Bash on Windows).
  const shell = 'bash';
  const quick = 'sleep 3; echo JOB_OUTPUT';
  const slow = 'sleep 60';

  f.host.reply = (_payload, index) => (index === 0 ? { tool: shell, args: { command: quick, run_in_background: true } } : { text: 'done' });
  const before = Date.now();
  await c.prompt('Start the job.');
  assert.ok(Date.now() - before < 2500, 'the turn ends while the command is still running');
  assert.match(c.toolResults(shell)[0].result.content[0].text, /Started background job job-1/);
  // The exit wakes the idle agent: a new run starts with the result in context and no user prompt.
  const requestsBefore = f.host.completions.length;
  await until(() => f.host.completions.length > requestsBefore);
  assert.match(JSON.stringify(f.host.completions.at(-1).messages), /Background job job-1 .*exited with code 0[\s\S]*JOB_OUTPUT/);
  await c.waitFor((event) => event.type === 'agent_settled', 20000, c.events.findLastIndex((event) => event.type === 'agent_start'));

  let step = 0;
  f.host.reply = () => [
    { tool: shell, args: { command: slow, run_in_background: true } },
    { tool: 'background_job', args: { action: 'list' } },
    { tool: 'background_job', args: { action: 'stop', id: 'job-2' } },
    { tool: shell, args: { command: 'echo FOREGROUND; exit 3' } },
  ][step++] ?? { text: 'done' };
  const wakeups = f.host.completions.length;
  await c.prompt('Start a long job, then stop it.');
  const [list, stopped] = c.toolResults('background_job');
  assert.match(list.result.content[0].text, /job-2 running/);
  assert.equal(stopped.result.details.job.state, 'stopped');
  // A foreground call still behaves like Pi's own tool, including a failing exit code.
  const foreground = c.toolResults(shell).at(-1);
  assert.match(JSON.stringify(foreground.result), /FOREGROUND/);
  assert.equal(foreground.isError, true);
  // Stopping a job on purpose does not wake the agent again.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.host.completions.length, wakeups + 5);
  assert.deepEqual(c.errors(), []);
});

test('ask_user shows a choice or a free-text question and returns the answer', { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.client();
  f.host.reply = (_payload, index) => [
    { tool: 'ask_user', args: { question: 'Which one?', options: ['First', 'Second'] } },
    { tool: 'ask_user', args: { question: 'Name it.' } },
  ][index] ?? { text: 'done' };
  const run = c.prompt('Ask me.');
  const select = await c.waitFor((event) => event.type === 'extension_ui_request' && event.method === 'select');
  assert.deepEqual(select.options, ['First', 'Second']);
  c.send({ type: 'extension_ui_response', id: select.id, value: 'Second' });
  const input = await c.waitFor((event) => event.type === 'extension_ui_request' && event.method === 'input');
  c.send({ type: 'extension_ui_response', id: input.id, value: 'A name' });
  await run;
  assert.deepEqual(c.toolResults('ask_user').map((event) => event.result.details.answer), ['Second', 'A name']);
});

test('a skill added, edited or removed while idle is reloaded without a model request', { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const skills = join(f.paths.home, '.agents', 'skills');
  skill(skills, 'first', 'FIRST_OLD');
  const c = f.client();
  const commands = async () => (await c.request('get_commands')).data.commands;
  const { sessionFile } = (await c.request('get_state')).data;
  assert.ok((await commands()).some((command) => command.name === 'skill:first'));

  skill(skills, 'second', 'SECOND');
  await until(async () => (await commands()).some((command) => command.name === 'skill:second'));
  skill(skills, 'first', 'FIRST_NEW');
  await until(async () => (await commands()).find((command) => command.name === 'skill:first')?.description === 'FIRST_NEW');
  rmSync(join(skills, 'second'), { recursive: true });
  await until(async () => !(await commands()).some((command) => command.name === 'skill:second'));

  writeFileSync(join(f.paths.profile, 'AGENTS.md'), 'INSTRUCTIONS_ADDED\n');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(f.host.completions.length, 0, 'reloading never calls the model');
  await c.prompt('Hello.');
  assert.match(systemText(f.host.completions.at(-1)), /INSTRUCTIONS_ADDED/);
  assert.equal((await c.request('get_state')).data.sessionFile, sessionFile, 'same conversation');
  assert.deepEqual(c.errors(), []);
});

test('/pi-trust asks through the client and applies to the next session', { timeout: 60000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  mkdirSync(join(f.paths.work, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(f.paths.work, '.pi', 'extensions', 'project.ts'), 'export default function (pi) { pi.registerCommand("project-command", { description: "from the project", handler: async () => {} }); }');
  const c = f.client();
  const hasProjectCommand = async (client) => (await client.request('get_commands')).data.commands.some((command) => command.name === 'project-command');
  assert.equal(await hasProjectCommand(c), false, 'untrusted project code is not loaded');
  const { sessionFile } = (await c.request('get_state')).data;
  const trusting = c.prompt('/pi-trust');
  const confirm = await c.waitFor((event) => event.type === 'extension_ui_request' && event.method === 'confirm');
  c.send({ type: 'extension_ui_response', id: confirm.id, confirmed: true });
  await trusting;
  assert.match(c.notices().at(-1), /Trust saved/);
  await c.close();
  const next = f.client({ args: ['--session', sessionFile] });
  assert.equal(await hasProjectCommand(next), true);
});
