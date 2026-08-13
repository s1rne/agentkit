import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
                   ".agentkit/providers.json",
                   ".agentkit/roles/integrator.md",
                   ".agentkit/skills/workspace-protocol.md", ".agentkit/skills/provider-routing.md",
                   ".agentkit/skills/resource-limits.md", ".agentkit/skills/context-budget.md",
                   ".agentkit/state/BOOT.md", ".agentkit/state/NOW.md", ".agentkit/state/TEAM.md",
                   "tasks/README.md", "tasks/BOARD.md", "docs/adr/README.md",
                   "CLAUDE.md", "AGENTS.md", ".cursor/rules/agentkit-team-protocol.mdc",
                   ".cursor/rules/agentkit-roles.mdc"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  assert.equal(cfg.project.language, "en", "English is the default");
  assert.equal(Object.values(cfg.roles).filter((r) => r.enabled).length, 11);
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

test("every skill a role references exists, in both languages", () => {
  for (const lang of ["en", "ru"]) {
    const dir = tmp();
    run(["init", "--lang", lang, "--pack", "full"], dir);
    const roles = path.join(dir, ".agentkit/roles");
    const skills = new Set(fs.readdirSync(path.join(dir, ".agentkit/skills")).map((f) => f.replace(/\.md$/, "")));
    for (const f of fs.readdirSync(roles)) {
      const front = fs.readFileSync(path.join(roles, f), "utf8").split("---")[1] || "";
      const line = front.split("\n").find((l) => l.startsWith("skills:"));
      if (!line) continue;
      for (const s of line.replace("skills:", "").replace(/[[\]]/g, "").split(",").map((x) => x.trim()).filter(Boolean)) {
        assert.ok(skills.has(s), `${lang}/${f} references missing skill "${s}"`);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("a role's declared tools decide whether it may be given a writing box", async () => {
  const dir = tmp();
  run(["init", "--pack", "full"], dir);
  const { roleWrites } = await import("../lib/orchestrator.mjs");
  // `tools:` is a bare comma list in the templates, not a bracketed array —
  // reading it as one string once put backend-dev into a read-only box.
  for (const r of ["backend-dev", "planner", "architect", "scribe", "integrator"]) {
    assert.equal(roleWrites(dir, r), true, `${r} must be able to write`);
  }
  for (const r of ["critic", "security-auditor", "domain-analyst"]) {
    assert.equal(roleWrites(dir, r), false, `${r} must not be given a writing box`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("run transcripts are kept out of the repository and pruned", async () => {
  const dir = tmp();
  run(["init"], dir);
  const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.ok(gi.includes(".agentkit/state/runs/"), "transcripts must never be committed");
  run(["init", "--force"], dir);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").match(/agentkit:start/g).length, 1);

  const { pruneRuns } = await import("../lib/orchestrator.mjs");
  const runs = path.join(dir, ".agentkit/state/runs");
  fs.mkdirSync(runs, { recursive: true });
  const old = path.join(runs, "R-old.jsonl");
  fs.writeFileSync(old, "x".repeat(1000));
  fs.utimesSync(old, new Date(0), new Date(Date.now() - 30 * 86400000));
  const fresh = path.join(runs, "R-fresh.jsonl");
  fs.writeFileSync(fresh, "y");
  const r = pruneRuns(dir, { keepDays: 14, keepLast: 50 });
  assert.equal(r.removed, 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh), "only the stale transcript goes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the active-run registry survives concurrent writers", async () => {
  const dir = tmp();
  const home = tmp();
  process.env.AGENTKIT_HOME = home;
  run(["init"], dir);
  const { activeRuns } = await import("../lib/orchestrator.mjs");
  // Machine-wide, not per repo: two projects on one laptop share one CPU.
  const f = path.join(home, "active-runs.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });

  // A row whose process is gone must not shrink the fleet forever.
  fs.writeFileSync(f, JSON.stringify([{ runId: "R-dead", pid: 999999 }, { runId: "R-me", pid: process.pid }]));
  const live = activeRuns(dir);
  assert.deepEqual(live.map((r) => r.runId), ["R-me"]);

  // Corrupt state is a zero, not a crash: bookkeeping must never block real work.
  fs.writeFileSync(f, "{ not json");
  assert.deepEqual(activeRuns(dir), []);

  // Twelve processes racing on the same file must lose no rows: without the lock
  // a read-modify-write cycle drops entries and the fleet over-subscribes.
  fs.writeFileSync(f, "[]");
  const mod = JSON.stringify(new URL("../lib/orchestrator.mjs", import.meta.url).href);
  const racers = Array.from({ length: 12 }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `const {trackActive} = await import(${mod});` +
          `trackActive(${JSON.stringify(dir)}, {runId: "R-${i}", pid: process.ppid});`,
      ], { env: { ...process.env, AGENTKIT_HOME: home } });
      p.on("close", resolve);
    })
  );
  await Promise.all(racers);
  const rows = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(rows.length, 12, `lost rows: got ${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.runId)).size, 12, "duplicate rows");
  delete process.env.AGENTKIT_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("a reviewer never gains write access from an implementer's box", async () => {
  const dir = tmp();
  const home = tmp();
  process.env.AGENTKIT_HOME = home;
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  run(["init", "--pack", "full"], dir);

  const { run: orchRun } = await import("../lib/orchestrator.mjs");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  const providers = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/providers.json"), "utf8"));

  const impl = await orchRun(dir, { ...cfg, providers }, { task: "T-9", role: "backend-dev", writers: 2, dryRun: true });
  assert.equal(impl.box.mode, "worktree");
  assert.equal(impl.box.permission, "isolated");

  // The box is reused by task id, so the critic gets the implementer's worktree —
  // which holds uncommitted work. Permission must follow the stricter decision.
  const rev = await orchRun(dir, { ...cfg, providers }, { task: "T-9", role: "critic", dryRun: true });
  assert.equal(rev.box.mode, "worktree", "the reviewer sees the tree that was built");
  assert.equal(rev.box.permission, "read", "but must not be able to write in it");
  assert.ok(rev.command.includes("--permission-mode plan"), rev.command);
  assert.ok(rev.command.includes("--disallowed-tools"), rev.command);
  // A dry run exists to show the flags, so the prompt must not crowd them out.
  assert.ok(/<prompt:\d+c>/.test(rev.command), rev.command);

  delete process.env.AGENTKIT_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("the skills route launches through the guarded runner", () => {
  // The admission check, box selection, permission mapping and accounting all
  // live in `agentkit run`. A lead that spawns agents directly gets none of them,
  // so the protocols must name the runner or the whole layer is decorative.
  for (const lang of ["en", "ru"]) {
    const dir = tmp();
    run(["init", "--lang", lang, "--pack", "full"], dir);
    for (const s of ["parallel-work", "tech-lead", "workspace-protocol"]) {
      const text = fs.readFileSync(path.join(dir, ".agentkit/skills", `${s}.md`), "utf8");
      assert.ok(text.includes("agentkit run"), `${lang}/${s} does not mention the runner`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
