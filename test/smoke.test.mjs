import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentkit.mjs");
const run = (args, cwd) => execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));

test("init deploys the full set", () => {
  const dir = tmp();
  run(["init", "--pack", "web-product", "--adapters", "claude-code,cursor,agents-md"], dir);

  for (const f of [".agentkit/config.json", ".agentkit/PROJECT.md", ".agentkit/HOUSE-RULES.md",
                   ".agentkit/blocks/claude-code.md", ".agentkit/blocks/strings.json",
                   ".agentkit/state/BOOT.md", ".agentkit/state/NOW.md", ".agentkit/state/TEAM.md",
                   "tasks/README.md", "tasks/BOARD.md", "docs/adr/README.md",
                   "CLAUDE.md", "AGENTS.md", ".cursor/rules/agentkit-team-protocol.mdc",
                   ".cursor/rules/agentkit-roles.mdc"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  assert.equal(cfg.project.language, "en", "English is the default");
  assert.equal(Object.values(cfg.roles).filter((r) => r.enabled).length, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("English is the default and no Russian leaks into generated files", () => {
  const dir = tmp();
  run(["init", "--pack", "full", "--adapters", "claude-code,cursor,agents-md"], dir);
  const cyrillic = /[А-Яа-яЁё]/;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = [
    ...walk(path.join(dir, ".agentkit")),
    ...walk(path.join(dir, ".claude")),
    ...walk(path.join(dir, ".cursor")),
    path.join(dir, "CLAUDE.md"), path.join(dir, "AGENTS.md"),
    ...walk(path.join(dir, "tasks")), ...walk(path.join(dir, "docs")),
  ];
  const dirty = files.filter((f) => cyrillic.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(dirty.map((f) => path.relative(dir, f)), [], "Cyrillic text in an English install");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--lang ru installs the Russian set", () => {
  const dir = tmp();
  const out = run(["init", "--lang", "ru", "--adapters", "claude-code,agents-md"], dir);
  assert.ok(out.includes("Готово"), out);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  assert.equal(cfg.project.language, "ru");
  assert.ok(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes("Команда ИИ-агентов"));
  assert.ok(fs.readFileSync(path.join(dir, ".agentkit/state/BOOT.md"), "utf8").includes("нулевым контекстом"));
  // language sticks without repeating the flag
  assert.ok(run(["doctor"], dir).includes("Проблем нет"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sync is idempotent and leaves the human's text alone", () => {
  const dir = tmp();
  run(["init"], dir);
  const claude = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(claude, "# My project\n\nHuman text.\n\n" + fs.readFileSync(claude, "utf8"));
  run(["sync"], dir);
  run(["sync"], dir);
  const out = fs.readFileSync(claude, "utf8");
  assert.equal(out.match(/agentkit:start/g).length, 1, "there must be exactly one block");
  assert.ok(out.includes("Human text."), "the human's text was overwritten");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor passes on a fresh install", () => {
  const dir = tmp();
  run(["init"], dir);
  assert.ok(run(["doctor"], dir).includes("No problems"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the no-AI-attribution rule reaches the project", () => {
  const dir = tmp();
  run(["init", "--adapters", "claude-code,agents-md"], dir);
  assert.ok(fs.existsSync(path.join(dir, ".claude/skills/no-ai-attribution/SKILL.md")));
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    assert.ok(fs.readFileSync(path.join(dir, f), "utf8").includes("never marked as AI-made"), f);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
