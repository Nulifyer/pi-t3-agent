import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resourceFingerprint } from "../extensions/lib/resource-state.ts";

test("resource monitoring follows symlinked skill roots and detects additions, removals and target edits", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "pi-t3-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target"), link = join(root, "skills");
  mkdirSync(target); symlinkSync(target, link, "dir");
  symlinkSync(target, join(target, "cycle"), "dir");
  const initial = resourceFingerprint([link]);
  writeFileSync(join(target, "SKILL.md"), "fixture metadata");
  const added = resourceFingerprint([link]); assert.notEqual(added, initial);
  writeFileSync(join(target, "SKILL.md"), "updated fixture metadata");
  assert.notEqual(resourceFingerprint([link]), added);
  rmSync(join(target, "SKILL.md")); assert.equal(resourceFingerprint([link]), initial);
});
