import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandSessions, shellCommand } from "../extensions/lib/command-sessions.ts";

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const quote = (value: string) => "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
function script(directory: string, source: string, name = "fixture.cjs") {
  const path = join(directory, name);
  writeFileSync(path, source);
  return (process.platform === "win32" ? "& " : "") + quote(process.execPath) + " " + quote(path);
}
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for command");
    await pause(25);
  }
}
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "pi-t3-commands-"));
  const commands = new CommandSessions();
  t.after(async () => {
    await commands.close();
    rmSync(directory, { recursive: true, force: true });
    for (const job of commands.list()) rmSync(join(job.logPath, ".."), { recursive: true, force: true });
  });
  return { directory, commands };
}

test("captures cwd, both output streams and actual nonzero exit", async (t) => {
  const { directory, commands } = fixture(t);
  const job = commands.start(script(directory, 'require("node:fs").writeFileSync("cwd-marker", "requested-directory"); console.log("stdout-marker"); console.error("stderr-marker"); process.exit(7);'), directory);
  await until(() => commands.status(job.sessionId).processExited);
  const result = commands.status(job.sessionId);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(readFileSync(join(directory, "cwd-marker"), "utf8"), "requested-directory");
  assert.match(result.output, /stdout-marker/);
  assert.match(result.output, /stderr-marker/);
  assert.match(readFileSync(result.logPath, "utf8"), /stderr-marker/);
});
test("supports literal stdin without shell interpolation", async (t) => {
  const { directory, commands } = fixture(t);
  const job = commands.start(script(directory, 'process.stdin.once("data", data => { console.log("literal:" + data); process.exit(0); });'), directory);
  commands.input(job.sessionId, "hello $world `literal`\n");
  await until(() => commands.status(job.sessionId).processExited);
  const result = commands.status(job.sessionId);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /literal:hello \$world `literal`/);
});
test("bounds output and reports cursor truncation", async (t) => {
  const { directory, commands } = fixture(t);
  const job = commands.start(script(directory, 'process.stdout.write("x".repeat(100000));'), directory);
  await until(() => commands.status(job.sessionId).processExited);
  const result = commands.status(job.sessionId, 0);
  assert.equal(result.output.length, 8000);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.nextOffset > result.outputOffset);
  assert.ok(readFileSync(result.logPath).length >= 100000);
});
test("cancellation stops descendants before a delayed file write", async (t) => {
  const { directory, commands } = fixture(t);
  const marker = join(directory, "leaked");
  const child = join(directory, "child.cjs");
  writeFileSync(child, 'process.on("SIGTERM", () => {}); console.log("CHILD_READY"); setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "leaked"), 4000);');
  const command = script(directory, 'require("node:child_process").spawn(process.execPath, [' + JSON.stringify(child) + '], {stdio:"inherit"}); setInterval(() => {}, 1000);');
  const job = commands.start(command, directory);
  await until(() => commands.status(job.sessionId).output.includes("CHILD_READY"));
  const result = await commands.stop(job.sessionId);
  assert.equal(result.status, "stopped");
  assert.equal(result.processExited, true);
  assert.equal(result.logError, undefined);
  await pause(4100);
  assert.equal(existsSync(marker), false);
});
test("timeout and session close terminate running commands", async (t) => {
  const { directory, commands } = fixture(t);
  const command = script(directory, 'setInterval(() => {}, 1000);');
  const job = commands.start(command, directory, 1);
  await until(() => commands.status(job.sessionId).processExited);
  assert.equal(commands.status(job.sessionId).status, "timed-out");
  const next = commands.start(command, directory);
  await commands.close();
  assert.equal(commands.status(next.sessionId).processExited, true);
});
test("rejects invalid arguments and limits concurrent jobs", async (t) => {
  const { directory, commands } = fixture(t);
  assert.throws(() => commands.start(" ", directory));
  assert.throws(() => commands.start("unused", directory, 0));
  assert.throws(() => commands.status("unknown"));
  const command = script(directory, 'setInterval(() => {}, 1000);');
  for (let i = 0; i < 4; i++) commands.start(command, directory);
  assert.throws(() => commands.start(command, directory), /Four commands/);
});
test("log write failures retain output and process exit evidence", async (t) => {
  const { directory, commands } = fixture(t);
  const job = commands.start(script(directory, 'setTimeout(() => console.log("survived"), 250);'), directory);
  rmSync(join(job.logPath, ".."), { recursive: true, force: true });
  await until(() => commands.status(job.sessionId).processExited);
  const result = commands.status(job.sessionId);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /survived/);
  assert.match(result.logError ?? "", /ENOENT/);
});
test("PowerShell commands are encoded literally and Bash never enables a parent shell", () => {
  const invocation = shellCommand('Write-Output "$literal"; exit 7', "powershell", "win32");
  assert.equal(invocation.binary, "powershell.exe");
  assert.match(Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le"), /Write-Output "\$literal"; exit 7/);
  assert.deepEqual(shellCommand("echo hello", "bash", "linux"), { binary: "/bin/bash", args: ["-lc", "echo hello"] });
});
