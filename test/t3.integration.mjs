import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, t3ToolNames, until } from './helpers/pi-fixture.mjs';

test('T3 thread tools and another extension remain declared and execute across turns', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const c = await f.client();
  f.setReply((_request, index) => index === 0 ? { tool: 'mcp__t3-code__t3_thread_read', args: { threadId: 'fixture-thread' } } : index === 2 ? { tool: 'fixture_other' } : { text: 'done' });
  await c.prompt('Read an existing T3 thread.');
  await c.prompt('Use the other installed extension.');
  for (const request of f.completions) {
    const tools = request.tools.map(tool => tool.function.name);
    for (const name of t3ToolNames) assert.ok(tools.includes('mcp__t3-code__' + name), name);
    assert.ok(tools.includes('fixture_other'));
    assert.match(JSON.stringify(request.messages), /T3 Code is the user's interface/);
  }
  assert.ok(c.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'mcp__t3-code__t3_thread_read' && !event.isError));
  assert.ok(c.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'fixture_other' && !event.isError));
  assert.deepEqual(c.events.filter(event => event.type === 'extension_error'), []);
  await c.close();
});

test('cold T3 discovery, model refresh, context updates, retirement, outage and restricted helpers', { timeout: 45000 }, async t => {
  const f = await fixture({ discovery: true }); t.after(() => f.close());
  const c = await f.client({ offline: true });
  const localModels = async client => (await client.request('get_available_models')).data.models.filter(model => model.provider === 'local');
  assert.deepEqual((await localModels(c)).map(model => model.id), ['fixture-a']);
  assert.ok(f.requests.some(request => request.method === 'GET'));
  assert.equal((await c.request('get_state')).data.model.contextWindow, 16384);
  const helper = await f.client({ offline: true, bridge: false, extra: ['--no-extensions', '--no-tools'] });
  assert.equal((await helper.request('set_model', { provider: 'local', modelId: 'fixture-a' })).success, true);
  await helper.prompt('Fixture text from the restricted helper.');
  await helper.close();
  f.setCatalog([{ id: 'fixture-a', context: 8192 }, { id: 'fixture-b', context: 32768 }]);
  await until(async () => (await localModels(c)).some(model => model.id === 'fixture-b'));
  assert.deepEqual((await localModels(c)).map(model => model.id), ['fixture-a', 'fixture-b']);
  assert.equal((await c.request('get_state')).data.model.contextWindow, 8192);
  const saved = JSON.parse(readFileSync(join(f.profile, 'models.json'), 'utf8'));
  assert.deepEqual(saved.providers.local.models.map(model => model.id), ['fixture-a', 'fixture-b']);
  f.setOutage(true);
  await c.request('prompt', { message: '/t3-refresh-models' });
  assert.deepEqual((await localModels(c)).map(model => model.id), ['fixture-a', 'fixture-b']);
  f.setOutage(false); f.setCatalog([{ id: 'fixture-b', context: 32768 }]);
  await c.request('prompt', { message: '/t3-refresh-models' });
  assert.deepEqual((await localModels(c)).map(model => model.id), ['fixture-b']);
  const beforeCalls = f.completions.length;
  await c.prompt('The retired model must not run.');
  assert.equal(f.completions.length, beforeCalls);
  assert.equal((await c.request('get_state')).data.model.id, 'fixture-a');
  assert.ok(c.events.some(event => event.type === 'extension_ui_request' && event.method === 'notify' && event.message.includes('no longer enabled')));
  assert.deepEqual(c.events.filter(event => event.type === 'extension_error'), []);
  await c.close();
});

test('PI_T3_OFFLINE is an explicit network opt-out even for T3 catalog discovery', { timeout: 20000 }, async t => {
  const f = await fixture({ discovery: true }); t.after(() => f.close());
  const c = await f.client({ offline: true, environment: { PI_T3_OFFLINE: '1' } });
  const models = (await c.request('get_available_models')).data.models.filter(model => model.provider === 'local');
  assert.deepEqual(models, []);
  assert.equal(f.requests.filter(request => request.method === 'GET').length, 0);
  await c.close();
});

test('automatic resource reload keeps the process, conversation, plan and managed command', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const skills = join(f.directory, '.agents', 'skills'), first = join(skills, 'fixture-one');
  mkdirSync(first, { recursive: true });
  writeFileSync(join(first, 'SKILL.md'), '---\nname: fixture-one\ndescription: DESCRIPTION_OLD\n---\nBODY\n');
  writeFileSync(join(f.profile, 'AGENTS.md'), 'INSTRUCTIONS_OLD\n');
  const c = await f.client({ extra: ['--skill', skills], context: true });
  const before = (await c.request('get_state')).data;
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
  f.setReply((_request, index) => index === 0 ? { tool: 'command_session', args: { action: 'start', command, timeoutSeconds: 25 } } : index === 1 ? { tool: 'update_plan', args: { plan: [{ step: 'Retain fixture progress', status: 'in_progress' }] } } : { text: 'done' });
  await c.prompt('Start a fixture job and save progress.');
  const started = c.events.find(event => event.type === 'tool_execution_end' && event.toolName === 'command_session').result.details;
  const modelCalls = f.completions.length;
  const second = join(skills, 'fixture-two'); mkdirSync(second);
  writeFileSync(join(second, 'SKILL.md'), '---\nname: fixture-two\ndescription: NEW_SKILL\n---\nBODY\n');
  writeFileSync(join(first, 'SKILL.md'), '---\nname: fixture-one\ndescription: DESCRIPTION_NEW\n---\nBODY\n');
  writeFileSync(join(f.profile, 'AGENTS.md'), 'INSTRUCTIONS_NEW\n');
  await until(async () => (await c.request('get_commands')).data.commands.some(command => command.name === 'skill:fixture-two'));
  assert.equal(f.completions.length, modelCalls);
  assert.equal((await c.request('get_state')).data.sessionFile, before.sessionFile);
  let phase = 0;
  f.setReply(() => phase++ === 0 ? { tool: 'command_session', args: { action: 'status', sessionId: started.sessionId } } : phase === 2 ? { tool: 'update_plan' } : { text: 'done' });
  await c.prompt('Read the job and saved plan.');
  const status = c.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'command_session').at(-1);
  assert.equal(status.isError, false);
  assert.equal(status.result.details.sessionId, started.sessionId);
  assert.equal(status.result.details.processExited, false);
  const plan = c.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'update_plan').at(-1);
  assert.equal(plan.result.details.plan[0].step, 'Retain fixture progress');
  assert.match(JSON.stringify(f.completions.at(-1).messages), /INSTRUCTIONS_NEW/);
  const callsBeforeRemoval = f.completions.length;
  rmSync(second, { recursive: true });
  await until(async () => !(await c.request('get_commands')).data.commands.some(command => command.name === 'skill:fixture-two'));
  assert.equal(f.completions.length, callsBeforeRemoval);
  assert.deepEqual(c.events.filter(event => event.type === 'extension_error'), []);
  await c.close();
});

test('extension edits are reloaded without restarting the process or invoking the model', { timeout: 20000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const path = join(f.profile, 'extensions', 'fixture-command.ts');
  writeFileSync(path, 'export default function(pi){pi.registerCommand("fixture-version",{description:"OLD_EXTENSION",handler:async()=>{}});}');
  const c = await f.client();
  const before = (await c.request('get_state')).data;
  assert.equal((await c.request('get_commands')).data.commands.find(command => command.name === 'fixture-version').description, 'OLD_EXTENSION');
  writeFileSync(path, 'export default function(pi){pi.registerCommand("fixture-version",{description:"NEW_EXTENSION",handler:async(_args,ctx)=>ctx.ui.notify("NEW_EXTENSION_EXECUTED","info")});}');
  await until(async () => (await c.request('get_commands')).data.commands.find(command => command.name === 'fixture-version')?.description === 'NEW_EXTENSION');
  await c.request('prompt', { message: '/fixture-version' });
  assert.ok(c.events.some(event => event.type === 'extension_ui_request' && event.message === 'NEW_EXTENSION_EXECUTED'));
  assert.equal((await c.request('get_state')).data.sessionFile, before.sessionFile);
  assert.equal(f.completions.length, 0);
  assert.deepEqual(c.events.filter(event => event.type === 'extension_error'), []);
  await c.close();
});

test('resource updates wait until an active model response has settled', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const skills = join(f.directory, '.agents', 'skills'); mkdirSync(skills, { recursive: true });
  let release; const gate = new Promise(resolve => release = resolve);
  f.setReply(async () => { await gate; return { text: 'completed' }; });
  const c = await f.client({ extra: ['--skill', skills] });
  const running = c.prompt('Hold the fixture response.');
  await until(() => f.completions.length === 1);
  const path = join(skills, 'fixture-later'); mkdirSync(path);
  writeFileSync(join(path, 'SKILL.md'), '---\nname: fixture-later\ndescription: LATER\n---\nBODY\n');
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal((await c.request('get_commands')).data.commands.some(command => command.name === 'skill:fixture-later'), false);
  release(); await running;
  await until(async () => (await c.request('get_commands')).data.commands.some(command => command.name === 'skill:fixture-later'));
  assert.equal(f.completions.length, 1);
  assert.deepEqual(c.events.filter(event => event.type === 'extension_error'), []);
  await c.close();
});

test('questions support both selections and free text through extension UI', { timeout: 20000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const c = await f.client();
  f.setReply((_request, index) => index === 0 ? { tool: 'ask_user', args: { question: 'Fixture choice', choices: ['First', 'Second'] } } : index === 1 ? { tool: 'ask_user', args: { question: 'Fixture free text' } } : { text: 'done' });
  const run = c.prompt('Ask the fixture user.');
  await until(() => c.events.some(event => event.type === 'extension_ui_request' && event.method === 'select'));
  const select = c.events.find(event => event.type === 'extension_ui_request' && event.method === 'select');
  c.send({ type: 'extension_ui_response', id: select.id, value: 'Second' });
  await until(() => c.events.some(event => event.type === 'extension_ui_request' && event.method === 'input'));
  const input = c.events.find(event => event.type === 'extension_ui_request' && event.method === 'input');
  c.send({ type: 'extension_ui_response', id: input.id, value: 'Free reply' });
  await run;
  const answers = c.events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'ask_user').map(event => event.result.details.answer);
  assert.deepEqual(answers, ['Second', 'Free reply']);
  await c.close();
});

test('workspace trust is granted through T3 UI and applies on native resume', { timeout: 20000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const extensions = join(f.directory, '.pi', 'extensions'); mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'project.ts'), 'export default function(pi) { pi.registerCommand("fixture-project-resource", { description:"Trusted fixture",handler:async()=>{} }); }');
  const c = await f.client({ trustArgs: [] });
  assert.equal((await c.request('get_commands')).data.commands.some(command => command.name === 'fixture-project-resource'), false);
  const before = (await c.request('get_state')).data;
  const approval = c.request('prompt', { message: '/t3-trust' });
  await until(() => c.events.some(event => event.type === 'extension_ui_request' && event.method === 'confirm'));
  const confirm = c.events.find(event => event.type === 'extension_ui_request' && event.method === 'confirm');
  c.send({ type: 'extension_ui_response', id: confirm.id, confirmed: true });
  assert.equal((await approval).data.disposition, 'handled');
  await c.close();
  const resumed = await f.client({ trustArgs: [], extra: ['--session', before.sessionFile] });
  assert.equal((await resumed.request('get_commands')).data.commands.some(command => command.name === 'fixture-project-resource'), true);
  assert.equal((await resumed.request('get_state')).data.sessionFile, before.sessionFile);
  assert.equal(f.completions.length, 0);
  await resumed.close();
});
