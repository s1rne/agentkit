import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentkit.mjs");
const run = (args, cwd) => execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

test("init разворачивает полный набор", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));
  run(["init", "--pack", "web-product", "--adapters", "claude-code,cursor,agents-md"], dir);

  for (const f of [".agentkit/config.json", ".agentkit/PROJECT.md", ".agentkit/HOUSE-RULES.md",
                   ".agentkit/state/BOOT.md", ".agentkit/state/NOW.md", ".agentkit/state/TEAM.md",
                   "tasks/README.md", "docs/adr/README.md",
                   "CLAUDE.md", "AGENTS.md", ".cursor/rules/agentkit-team-protocol.mdc"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `нет ${f}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  assert.equal(Object.values(cfg.roles).filter((r) => r.enabled).length, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sync идемпотентен и не трогает текст человека", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));
  run(["init"], dir);
  const claude = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(claude, "# Мой проект\n\nТекст человека.\n\n" + fs.readFileSync(claude, "utf8"));
  run(["sync"], dir);
  run(["sync"], dir);
  const out = fs.readFileSync(claude, "utf8");
  assert.equal(out.match(/agentkit:start/g).length, 1, "блок должен быть один");
  assert.ok(out.includes("Текст человека."), "текст человека затёрт");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor проходит на свежей установке", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));
  run(["init"], dir);
  const out = run(["doctor"], dir);
  assert.ok(out.includes("Проблем нет"), out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("правило об отсутствии атрибуции ИИ доезжает до проекта", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-"));
  run(["init", "--adapters", "claude-code,agents-md"], dir);
  assert.ok(fs.existsSync(path.join(dir, ".claude/skills/no-ai-attribution/SKILL.md")));
  assert.ok(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes("не помечается как сделанная ИИ"));
  assert.ok(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").includes("не помечается как сделанная ИИ"));
  fs.rmSync(dir, { recursive: true, force: true });
});
