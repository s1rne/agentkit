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

test("adopt keeps a project's own agents instead of overwriting them", () => {
  const dir = tmp();
  // A project that built its own team by hand, in its own language and domain.
  fs.mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude/skills/domain-rules"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude/state"), { recursive: true });
  const mine = "---\nname: backend-dev\ndescription: Пишет модули core-api\ntools: Read, Write, Edit, Bash\ngroup: Реализация\ncap: 4\n---\n\nКаждая таблица содержит tenant_id, на каждой включён RLS.\n";
  fs.writeFileSync(path.join(dir, ".claude/agents/backend-dev.md"), mine);
  fs.writeFileSync(path.join(dir, ".claude/skills/domain-rules/SKILL.md"), "---\nname: domain-rules\ndescription: Правила предметной области\n---\n\nКПВ не участвует в GPA.\n");
  fs.writeFileSync(path.join(dir, ".claude/state/JOURNAL.md"), "# JOURNAL\n\nнаша история\n");

  const out = run(["adopt", "--lang", "ru"], dir);
  assert.match(out, /backup:/);

  // The hand-written definition is now the source, byte for byte.
  assert.equal(fs.readFileSync(path.join(dir, ".agentkit/roles/backend-dev.md"), "utf8"), mine);
  const generated = fs.readFileSync(path.join(dir, ".claude/agents/backend-dev.md"), "utf8");
  assert.ok(generated.includes("tenant_id"), "the domain body must survive regeneration");
  assert.ok(generated.includes("Пишет модули core-api"));

  // Its own skill and memory survive; the kit's additions arrive alongside.
  assert.ok(fs.existsSync(path.join(dir, ".agentkit/skills/domain-rules.md")));
  assert.match(fs.readFileSync(path.join(dir, ".agentkit/state/JOURNAL.md"), "utf8"), /наша история/);
  for (const s of ["workspace-protocol", "provider-routing", "resource-limits", "context-budget"]) {
    assert.ok(fs.existsSync(path.join(dir, ".agentkit/skills", `${s}.md`)), `missing ${s}`);
  }
  assert.ok(fs.existsSync(path.join(dir, ".agentkit/providers.json")));

  // The untouched original stays recoverable.
  const backup = fs.readdirSync(dir).find((f) => f.startsWith(".claude.before-agentkit-"));
  assert.equal(fs.readFileSync(path.join(dir, backup, "agents/backend-dev.md"), "utf8"), mine);

  // A second adopt must not silently overwrite what is now the source.
  assert.throws(() => run(["adopt"], dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a run's report lands in the task file, not only in the log", async () => {
  const dir = tmp();
  run(["init", "--lang", "ru", "--pack", "full"], dir);
  const taskFile = path.join(dir, "tasks/tasks/T-0042-проверка.md");
  fs.writeFileSync(taskFile, "---\nid: T-0042\ntitle: Проверка\nstatus: todo\n---\n\n## Зачем\n\nтекст\n");

  const { appendReportToTask } = await import("../lib/orchestrator.mjs");
  // The critic has no write tools, so its findings reach the author only if the
  // orchestrator files them. That is the whole handoff.
  const ok = appendReportToTask(dir, {
    task: "T-0042", role: "critic", status: "done",
    box: { branch: "ak/T-0042" },
    summary: "НАЙДЕНО: healthcheck MinIO требует alias.",
  }, "ru");
  assert.equal(ok, true);
  let text = fs.readFileSync(taskFile, "utf8");
  assert.ok(text.includes("## Отчёты по запускам"));
  assert.ok(text.includes("### critic"));
  assert.ok(text.includes("healthcheck MinIO"));
  assert.ok(text.includes("ak/T-0042"));
  assert.ok(text.startsWith("---\nid: T-0042"), "frontmatter must survive");

  appendReportToTask(dir, { task: "T-0042", role: "architect", status: "done", summary: "СДЕЛАНО: поправил." }, "ru");
  text = fs.readFileSync(taskFile, "utf8");
  assert.equal(text.match(/## Отчёты по запускам/g).length, 1, "one section, appended to");
  assert.ok(text.indexOf("### critic") < text.indexOf("### architect"), "history reads top to bottom");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overlapping work areas are detected as paths, not as strings", async () => {
  const { overlap, collisions } = await import("../lib/team.mjs");
  // packages/db and packages/db/client are one package under two spellings.
  // Missing this once cost two incompatible contracts and an architect to unpick them.
  assert.ok(overlap({ touches: ["packages/db"] }, { touches: ["packages/db/client"] }));
  assert.ok(overlap({ touches: ["packages/db/client"] }, { touches: ["packages/db"] }));
  assert.ok(overlap({ touches: ["apps/web"] }, { touches: ["apps/web"] }));
  // A shared prefix that is not a path boundary is not an overlap.
  assert.equal(overlap({ touches: ["packages/dbx"] }, { touches: ["packages/db"] }), null);
  assert.equal(overlap({ touches: ["packages/db"] }, { touches: ["packages/config"] }), null);
  // Trailing slashes and comma-joined frontmatter must not fool it.
  assert.ok(overlap({ touches: ["packages/db/"] }, { touches: "packages/db/client" }));

  const cl = collisions([
    { id: "T-1", touches: ["packages/db"] },
    { id: "T-2", touches: ["packages/db/client"] },
    { id: "T-3", touches: ["apps/web"] },
  ]);
  assert.equal(cl.length, 1);
  assert.deepEqual([cl[0].a, cl[0].b], ["T-1", "T-2"]);
});

test("a task's declared risk decides its box, even when the caller forgets", async () => {
  const dir = tmp();
  const home = tmp();
  process.env.AGENTKIT_HOME = home;
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  run(["init", "--pack", "full"], dir);
  fs.writeFileSync(
    path.join(dir, "tasks/tasks/T-0099-опасная.md"),
    "---\nid: T-0099\ntitle: Опасная\nstatus: todo\nowner: data-engineer\nrisk: high\n---\n\n## Зачем\n\nтекст\n"
  );

  const { run: orchRun } = await import("../lib/orchestrator.mjs");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  const providers = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/providers.json"), "utf8"));

  // The caller passes no risk at all. Before this, the task landed in a shared
  // box and wrote straight into the human's working directory.
  const r = await orchRun(dir, { ...cfg, providers }, { task: "T-0099", dryRun: true });
  assert.equal(r.box.mode, "worktree", `risk: high must isolate, got ${r.box.mode}`);
  assert.equal(r.box.permission, "isolated");
  assert.equal(r.role, "data-engineer", "owner comes from the task when not given");

  delete process.env.AGENTKIT_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("the wave decides readiness, merges and knows when a conflict is not its business", async () => {
  const dir = tmp();
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  g("commit", "-q", "--allow-empty", "-m", "base");
  run(["init", "--pack", "full"], dir);
  g("add", "-A"); g("commit", "-q", "-m", "kit");

  const w = await import("../lib/wave.mjs");
  const mk = (id, extra = "") =>
    fs.writeFileSync(path.join(dir, `tasks/tasks/${id}.md`), `---\nid: ${id}\ntitle: ${id}\nstatus: todo\n${extra}---\n\n## Зачем\n\nx\n`);

  mk("T-0001");
  mk("T-0002", "blocked_by: T-0001\n");
  // A dependency that is merely accepted is not available: a box is branched
  // from the base branch and would not contain its work.
  let all = w.ready(dir, [
    { file: "", data: { id: "T-0001", status: "review" }, body: "" },
    { file: "", data: { id: "T-0002", status: "todo", blocked_by: "T-0001" }, body: "" },
  ]);
  assert.deepEqual(all.map((t) => t.data.id), []);

  // A real branch with real work merges, and the task history is unioned.
  g("checkout", "-q", "-b", "ak/T-0007");
  fs.writeFileSync(path.join(dir, "feature.txt"), "работа\n");
  g("add", "-A"); g("commit", "-q", "-m", "работа");
  g("checkout", "-q", "main");
  const ok = w.mergeBranch(dir, "T-0007", "проверка");
  assert.equal(ok.ok, true, ok.why);
  assert.ok(fs.existsSync(path.join(dir, "feature.txt")));

  // A conflict in code is not merged by rule — it is handed on.
  g("checkout", "-q", "-b", "ak/T-0008");
  fs.writeFileSync(path.join(dir, "feature.txt"), "их версия\n");
  g("add", "-A"); g("commit", "-q", "-m", "их");
  g("checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "feature.txt"), "наша версия\n");
  g("add", "-A"); g("commit", "-q", "-m", "наша");
  const bad = w.mergeBranch(dir, "T-0008", "столкновение");
  assert.equal(bad.ok, false);
  assert.equal(bad.needsIntegrator, true, "конфликт в коде обязан уйти дальше, а не быть сведён правилом");
  assert.equal(g("status", "--porcelain").trim(), "", "после отказа дерево должно быть чистым");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("project limits reach the run without being restated", async () => {
  const dir = tmp();
  const home = tmp();
  process.env.AGENTKIT_HOME = home;
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  run(["init", "--pack", "full"], dir);
  const pf = path.join(dir, ".agentkit/providers.json");
  const providers = JSON.parse(fs.readFileSync(pf, "utf8"));
  providers.limits.maxAgentMinutes = 45;
  fs.writeFileSync(pf, JSON.stringify(providers, null, 2));

  fs.writeFileSync(path.join(dir, "tasks/tasks/T-0050-долгая.md"),
    "---\nid: T-0050\ntitle: Долгая\nstatus: todo\nowner: backend-dev\n---\n\n## Зачем\n\nx\n");

  const { run: orchRun } = await import("../lib/orchestrator.mjs");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agentkit/config.json"), "utf8"));
  // The caller passes no limits. Before this, the default 20-minute ceiling
  // silently applied and killed agents at 20 minutes on a project set to 45.
  const r = await orchRun(dir, { ...cfg, providers }, { task: "T-0050", dryRun: true });
  assert.equal(r.status, "dry-run");
  assert.equal(r.limits.maxAgentMinutes, 45, "the project's ceiling must reach the run");

  delete process.env.AGENTKIT_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("a task's copy catches up with the base branch before work starts", async () => {
  const dir = tmp();
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  g("commit", "-q", "--allow-empty", "-m", "base");
  run(["init", "--pack", "full"], dir);
  g("add", "-A"); g("commit", "-q", "-m", "kit");

  const w = await import("../lib/wave.mjs");
  const box = path.join(dir, "..", `box-${path.basename(dir)}`);
  g("worktree", "add", "-q", "-b", "ak/T-0060", box);

  // The base branch moves on; the copy does not notice by itself.
  fs.writeFileSync(path.join(dir, "contract.ts"), "export const v = 2;\n");
  g("add", "-A"); g("commit", "-q", "-m", "контракт изменился");
  assert.ok(!fs.existsSync(path.join(box, "contract.ts")), "копия ещё не видит новый контракт");

  const r = w.refresh(dir, "T-0060", "main");
  assert.equal(r.ok, true);
  assert.equal(r.refreshed, true);
  assert.ok(fs.existsSync(path.join(box, "contract.ts")), "после подтягивания копия видит проект");

  // Nothing to catch up on the second time.
  assert.equal(w.refresh(dir, "T-0060", "main").behind, 0);

  execFileSync("git", ["-C", dir, "worktree", "remove", "--force", box]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a task that depends on nothing says so with an empty field, not with a task named null", async () => {
  const { parseFront } = await import("../lib/util.mjs");
  for (const written of ["null", "~", ""]) {
    const { data } = parseFront(`---\nid: T-0001\nstatus: todo\nblocked_by: ${written}\n---\nтело`);
    assert.equal(data.blocked_by, null, `blocked_by: ${JSON.stringify(written)}`);
  }

  const dir = tmp();
  execFileSync("git", ["-C", dir, "init", "-q"], { cwd: dir });
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  g("commit", "-q", "--allow-empty", "-m", "base");

  // The planner writes `blocked_by: null` by itself for the first task of an
  // order. Read as a string it became a dependency on a task called "null",
  // nothing was ever ready, and the wave printed "the queue is empty".
  const w = await import("../lib/wave.mjs");
  const all = [
    { file: "", data: { id: "T-0001", status: "todo", blocked_by: null }, body: "" },
    { file: "", data: { id: "T-0002", status: "todo", blocked_by: "T-0001" }, body: "" },
  ];
  assert.deepEqual(w.ready(dir, all).map((t) => t.data.id), ["T-0001"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
