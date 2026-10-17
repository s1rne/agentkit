import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PORTABLE } from "../lib/export.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentkit.mjs");
const run = (args, cwd) => execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));

/** Entries of a zip, read from the central directory: name → inflated content. */
function unzip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out[name] = zlib.inflateRawSync(buf.subarray(start, start + size)).toString();
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test("export writes every portable protocol as a standalone skill", () => {
  const dir = tmp();
  run(["export"], dir);
  for (const name of Object.keys(PORTABLE)) {
    const skill = fs.readFileSync(path.join(dir, "agentkit-skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    assert.doesNotMatch(skill, /\.agentkit\/|agentkit run/, `${name} depends on the agentkit runtime`);
  }
  assert.ok(fs.existsSync(path.join(dir, "agentkit-skills", "adversarial-review", "agents", "critic.md")));
});

test("export --zip packs a folder that unpacks to the skill directory", () => {
  const dir = tmp();
  run(["export", "adversarial-review", "--zip", "--out", "dist"], dir);
  const entries = unzip(path.join(dir, "dist", "adversarial-review.zip"));
  assert.deepEqual(Object.keys(entries).sort(), ["adversarial-review/SKILL.md", "adversarial-review/agents/critic.md"]);
  assert.equal(entries["adversarial-review/SKILL.md"], fs.readFileSync(path.join(dir, "dist", "adversarial-review", "SKILL.md"), "utf8"));
});

test("export refuses a protocol that needs the agentkit runtime", () => {
  assert.throws(() => run(["export", "workspace-protocol"], tmp()), /not portable/);
});
