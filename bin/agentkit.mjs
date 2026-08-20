#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { c, log, ok, warn, err, readDir, write, copyIfAbsent, parseFront, loadConfig, activeRoles, ensureGitignore } from "../lib/util.mjs";
import { messages, LANGS } from "../lib/i18n.mjs";
import { riskyEnvPresent } from "../lib/env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const ROOT = process.cwd();

const ADAPTERS = {
  "claude-code": () => import("../lib/adapters/claude-code.mjs"),
  cursor: () => import("../lib/adapters/cursor.mjs"),
  "agents-md": () => import("../lib/adapters/agents-md.mjs"),
};

// Markers left in templates where the human has to fill something in.
const UNFILLED = ["FILL IN", "ЗАПОЛНИ"];
const unfilled = (file) => fs.existsSync(file) && UNFILLED.some((m) => fs.readFileSync(file, "utf8").includes(m));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (f) => process.argv.includes(`--${f}`);

/**
 * Машинно-читаемый вывод.
 *
 * Напечатанное рассчитано на человека: цвет, выравнивание пробелами, слова на
 * языке проекта. Сервису, который вынужден это разбирать, ломает разбор смена
 * формулировки, смена языка и ширина колонки — а нам такой разбор запрещает
 * менять то, что специально делалось удобным для чтения. Поэтому наружу
 * отдаётся то же самое, что уже посчитано, без оформления.
 */
const json = (data) => log(JSON.stringify(data, null, 2));

/** Задачи по статусам — та же доска, только числами. */
function taskCounts(root) {
  const out = {};
  for (const sub of ["epics", "features", "tasks", "done"]) {
    const dir = path.join(root, "tasks", sub);
    for (const f of readDir(dir)) {
      const { data } = parseFront(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!data.id) continue;
      const status = String(data.status || "unknown");
      out[status] = (out[status] || 0) + 1;
    }
  }
  return out;
}

/** Задача без тела: наблюдателю нужны поля, а не текст задачи целиком. */
const briefTask = (t) =>
  t && {
    id: t.id,
    title: t.title ?? null,
    status: t.status ?? null,
    owner: t.owner ?? null,
    risk: t.risk ?? null,
    blocked_by: t.blocked_by ?? null,
    touches: [].concat(t.touches || []),
    file: t.file ?? null,
  };

/** Language of an existing install, overridable by --lang. English by default. */
function resolveLang(fallback) {
  const flag = arg("lang", null);
  if (flag) return flag;
  const f = path.join(ROOT, ".agentkit", "config.json");
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")).project?.language || fallback;
    } catch {}
  }
  return fallback;
}

function copyTree(from, to, { overwrite = true } = {}) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) n += copyTree(s, d, { overwrite });
    else if (overwrite || !fs.existsSync(d)) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

// ─────────────────────────────── init

async function cmdInit() {
  const lang = arg("lang", "en");
  const t = messages(LANGS.includes(lang) ? lang : "en");
  const packName = arg("pack", "base");
  const adapters = arg("adapters", "claude-code").split(",").map((s) => s.trim());
  const dest = path.join(ROOT, ".agentkit");

  if (!LANGS.includes(lang)) {
    err(t.noLang(lang, LANGS.join(", ")));
    process.exit(1);
  }
  const tpl = (...p) => path.join(PKG, "template", lang, ...p);

  if (fs.existsSync(dest) && !has("force")) {
    err(t.existsAlready);
    process.exit(1);
  }

  const packFile = path.join(PKG, "packs", `${packName}.json`);
  if (!fs.existsSync(packFile)) {
    err(t.noPack(packName, fs.readdirSync(path.join(PKG, "packs")).map((f) => f.replace(".json", "")).join(", ")));
    process.exit(1);
  }
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));

  log(c.b(`\n  ${t.initHeader}`), c.dim(t.initMeta(packName, adapters.join(", "), lang) + "\n"));

  // Core: roles, skills, commands, block templates — regenerated, safe to overwrite
  for (const d of ["roles", "skills", "commands", "blocks"]) {
    copyTree(tpl(d), path.join(dest, d));
  }
  ok(t.coreCopied);

  // Memory, human interface, tasks — only when absent: this is project state
  let kept = 0;
  for (const f of readDir(tpl("memory"))) {
    if (!copyIfAbsent(tpl("memory", f), path.join(dest, "state", f))) kept++;
  }
  for (const f of readDir(tpl("human"))) {
    copyIfAbsent(tpl("human", f), path.join(dest, f));
  }
  for (const f of readDir(tpl("docs", "adr"))) {
    copyIfAbsent(tpl("docs", "adr", f), path.join(ROOT, "docs", "adr", f));
  }
  for (const f of readDir(tpl("tasks"))) {
    copyIfAbsent(tpl("tasks", f), path.join(ROOT, "tasks", f));
  }
  for (const d of ["epics", "features", "tasks", "done"]) {
    fs.mkdirSync(path.join(ROOT, "tasks", d), { recursive: true });
  }
  copyIfAbsent(path.join(PKG, "template", "providers.json"), path.join(dest, "providers.json"));
  ensureGitignore(ROOT, [".agentkit/state/runs/", ".agentkit/state/.providers-cache.json"]);
  ok(kept ? t.memoryKept(kept) : t.memoryCreated);
  ok(t.humanIface);
  ok(t.tasksAdr);

  // Config
  const roles = {};
  for (const f of readDir(path.join(dest, "roles"))) {
    const { data } = parseFront(fs.readFileSync(path.join(dest, "roles", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    const on = pack.roles.includes(name);
    roles[name] = { enabled: on, cap: data.cap ?? 1, ...(on ? {} : { reason: t.notInPack(packName) }) };
  }
  write(
    path.join(dest, "config.json"),
    JSON.stringify(
      { $schema: "./schema.json", version: 1, pack: packName, adapters, project: { name: path.basename(ROOT), language: lang }, roles },
      null,
      2
    ) + "\n"
  );
  ok(t.configWritten);

  await cmdSync(true);

  // Cheap: probes are `command -v` plus an auth-status call, no model is invoked.
  // BOOT.md points at PROVIDERS.md, so it must exist from the first session.
  try {
    const { probeAll, summary } = await import("../lib/providers/index.mjs");
    const probes = await probeAll({
      accounts: providersConfig(ROOT).accounts,
      cacheFile: path.join(dest, "state", ".providers-cache.json"),
    });
    write(path.join(dest, "state", "PROVIDERS.md"), summary(probes));
    const ready = Object.entries(probes.providers).filter(([, p]) => p.state === "ready").map(([id]) => id);
    ok(`providers: ${ready.join(", ") || "none ready"} — see .agentkit/state/PROVIDERS.md`);
  } catch {
    warn("could not probe providers — run: npx @s1rne/agentkit providers");
  }

  log(c.b(`\n  ${t.done}\n`));
  log("  " + t.nextSteps);
  log(c.dim("    1.") + " " + t.step1);
  log(c.dim("    2.") + " " + t.step2);
  log(c.dim("    3.") + " " + t.step3);
  log("");
  log("  " + t.thenBoot(c.b("/boot")) + "\n");
}

// ─────────────────────────────── sync

async function cmdSync(quiet) {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  if (!quiet) log(c.b(`\n  ${t.syncHeader}\n`));
  for (const a of cfg.adapters) {
    const loader = ADAPTERS[a];
    if (!loader) { warn(t.unknownAdapter(a)); continue; }
    const mod = await loader();
    mod.generate(ROOT, cfg);
  }
  if (!quiet) log("");
}

// ─────────────────────────────── doctor

async function cmdDoctor() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  log(c.b(`\n  ${t.doctorHeader}\n`));
  let problems = 0;
  const fail = (m) => { err(m); problems++; };

  // Memory
  for (const f of ["BOOT.md", "NOW.md", "JOURNAL.md", "DECISIONS.md", "TEAM.md", "RUNS.md"]) {
    fs.existsSync(path.join(ROOT, ".agentkit", "state", f)) ? ok(t.memoryFile(f)) : fail(t.memoryMissing(f));
  }

  // Human interface
  for (const f of ["PROJECT.md", "HOUSE-RULES.md", "INBOX.md", "QUESTIONS.md"]) {
    fs.existsSync(path.join(ROOT, ".agentkit", f)) ? ok(t.humanFile(f)) : fail(t.humanMissing(f));
  }
  const proj = path.join(ROOT, ".agentkit", "PROJECT.md");
  if (fs.existsSync(proj) && /<!--[\s\S]*?-->/.test(fs.readFileSync(proj, "utf8"))) {
    warn(t.projectEmpty);
  }

  // Roles named in the config exist as files
  const files = new Set(readDir(path.join(ROOT, ".agentkit", "roles")).map((f) => f.replace(/\.md$/, "")));
  for (const name of Object.keys(cfg.roles || {})) {
    if (!files.has(name)) fail(t.roleMissing(name));
  }

  // Skills that roles reference
  const skills = new Set(readDir(path.join(ROOT, ".agentkit", "skills")).map((f) => f.replace(/\.md$/, "")));
  for (const r of activeRoles(ROOT, cfg)) {
    for (const s of [].concat(r.data.skills || [])) {
      if (s && !skills.has(s)) fail(t.skillMissing(r.name, s));
    }
  }

  // NOW must not still be a template
  if (unfilled(path.join(ROOT, ".agentkit", "state", "NOW.md"))) warn(t.nowEmpty);

  // Две задачи в одном пакете дают не конфликт слияния, а два несовместимых замысла
  try {
    const { gather, collisions } = await import("../lib/team.mjs");
    const g = gather(ROOT, providersConfig(ROOT));
    const cl = collisions([...g.ready, ...g.active.map((a) => g.tasks.get(a.task))].filter(Boolean));
    for (const c of cl.slice(0, 5)) {
      warn(`${c.a} и ${c.b} трогают одно и то же (${c.at.a} ↔ ${c.at.b}) — одновременно не запускать`);
    }
  } catch {}

  // No version control means no undo for anything an agent writes
  try {
    execFileSync("git", ["-C", ROOT, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    warn("this project is not a git repository — agents can write here with no undo, and worktree isolation is unavailable");
  }

  // Metered credentials in the environment would silently bill every agent run
  const risky = riskyEnvPresent();
  if (risky.length) fail(t.riskyEnv(risky.join(", ")));

  // Generated files older than sources?
  const claudeAgents = path.join(ROOT, ".claude", "agents");
  if (cfg.adapters.includes("claude-code") && fs.existsSync(claudeAgents)) {
    const srcM = Math.max(...readDir(path.join(ROOT, ".agentkit", "roles")).map((f) => fs.statSync(path.join(ROOT, ".agentkit", "roles", f)).mtimeMs), 0);
    const genM = Math.min(...readDir(claudeAgents).map((f) => fs.statSync(path.join(claudeAgents, f)).mtimeMs), Infinity);
    if (srcM > genM) warn(t.staleGenerated);
  }

  const active = activeRoles(ROOT, cfg).length;
  log("");
  log(problems ? c.r(`  ${t.problems(problems)}`) : c.g(`  ${t.noProblems}`) + c.dim(t.activeRoles(active)));
  log("");
  process.exit(problems ? 1 : 0);
}

// ─────────────────────────────── status

function cmdStatus() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const roles = activeRoles(ROOT, cfg);
  const off = Object.entries(cfg.roles || {}).filter(([, v]) => v.enabled === false).map(([k]) => k);

  const now = path.join(ROOT, ".agentkit", "state", "NOW.md");
  const nowLine = fs.existsSync(now)
    ? fs.readFileSync(now, "utf8").split("\n").find((l) => l.startsWith("**") || (l.trim() && !l.startsWith("#") && !l.startsWith(">"))) || null
    : null;

  if (has("json")) {
    return json({
      project: cfg.project?.name ?? null,
      language: cfg.project?.language ?? null,
      pack: cfg.pack ?? null,
      adapters: cfg.adapters ?? [],
      roles: roles.map((r) => ({
        name: r.name,
        group: r.data.group ?? null,
        cap: r.cfg.cap ?? r.data.cap ?? 1,
      })),
      disabled: off,
      tasks: taskCounts(ROOT),
      now: nowLine ? nowLine.replace(/\*\*/g, "").trim() : null,
    });
  }

  log(c.b(`\n  ${cfg.project?.name || t.project}`), c.dim(t.statusMeta(cfg.pack, cfg.adapters.join(", ")) + "\n"));

  const byGroup = {};
  for (const r of roles) (byGroup[r.data.group || "—"] ||= []).push(r);
  for (const [g, list] of Object.entries(byGroup)) {
    log(c.dim(`  ${g}`));
    for (const r of list) log(`    ${r.name.padEnd(18)} ${c.dim(t.capUpTo(r.cfg.cap ?? r.data.cap ?? 1))}`);
  }
  if (off.length) log(c.dim(`\n  ${t.disabled(off.join(", "))}`));
  if (nowLine) log(c.dim("\n  " + t.nowLabel) + nowLine.replace(/\*\*/g, "").trim().slice(0, 90));
  log("");
}

// ─────────────────────────────── role

function cmdRole() {
  const [, , , sub, name, val] = process.argv;
  const cfgPath = path.join(ROOT, ".agentkit", "config.json");
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  if (!name) { err(t.roleNameRequired); process.exit(1); }
  cfg.roles[name] ||= { enabled: false, cap: 1 };

  if (sub === "enable") { cfg.roles[name].enabled = true; delete cfg.roles[name].reason; ok(t.roleEnabled(name)); }
  else if (sub === "disable") { cfg.roles[name].enabled = false; ok(t.roleDisabled(name)); }
  else if (sub === "cap") { cfg.roles[name].cap = Number(val); ok(t.roleCap(name, val)); }
  else { err(t.roleUsage); process.exit(1); }

  write(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  warn(t.rememberSync);
}

// ─────────────────────────────── run

async function cmdRun() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const orch = await import("../lib/orchestrator.mjs");
  const res = await import("../lib/resources.mjs");
  const pcfg = providersConfig(ROOT);

  const task = arg("task", process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null);
  const role = arg("role", "backend-dev");
  const needs = arg("needs", (pcfg.roles?.[role]?.needs || ["code"]).join(",")).split(",").map((x) => x.trim());

  log(c.b("\n  agentkit run"), c.dim(`· ${role} · ${task || "ad-hoc"}\n`));

  /**
   * `--wait` вместо мгновенного `deferred`.
   *
   * Без него вызывающий обязан сам крутить цикл повторов, и на живом прогоне
   * это дало худший из возможных исходов: конвейер счёл «нет места» провалом
   * исполнителя и за двадцать секунд прокрутил всю очередь вхолостую.
   * Ждать место — работа запускателя, а не каждого его пользователя.
   */
  const waitFor = has("wait") ? Number(arg("wait-minutes", 30)) * 60_000 : 0;
  const until = Date.now() + waitFor;

  const attempt = () => orch.run(ROOT, { ...cfg, providers: pcfg }, {
    task,
    role,
    needs,
    instruction: arg("instruction", null),
    writers: Number(arg("writers", 1)),
    risk: arg("risk", "normal"),
    kind: arg("kind", "normal"),
    mode: arg("mode", null),
    model: arg("model", null),
    depth: Number(arg("depth", 0)),
    parent: arg("parent", null),
    limits: { ...res.DEFAULT_LIMITS, ...pcfg.limits },
    dryRun: has("dry-run"),
    priority: has("priority"),
  });

  let report = await attempt();
  while (report.status === "deferred" && Date.now() < until) {
    log(c.dim(`      ${report.reason} — жду место, осталось ${Math.ceil((until - Date.now()) / 60000)} мин`));
    await new Promise((r) => setTimeout(r, 20_000));
    report = await attempt();
  }

  const line = `${report.status}${report.reason ? " — " + report.reason : ""}`;
  report.status === "done" ? ok(line) : report.status === "failed" || report.status === "killed" ? err(line) : warn(line);
  if (report.box) log(c.dim(`      box: ${report.box.mode}${report.box.branch ? " · " + report.box.branch : ""} — ${report.box.reason}`));
  if (report.box?.warning) warn(report.box.warning);
  if (report.provider) log(c.dim(`      via: ${report.provider}${report.model ? " · " + report.model : ""}${report.degraded ? " (degraded: " + report.degradedReason + ")" : ""}`));
  if (report.usage) log(c.dim(`      tokens: ${report.usage.total?.toLocaleString("en-US")} · peak RSS ${report.peakRssMB}MB · ${Math.round(report.durationMs / 1000)}s`));
  if (report.command) log(c.dim(`      cmd: ${report.command}`));
  if (report.account) log(c.dim(`      account: ${report.account}`));
  if (report.summary) {
    log("");
    for (const l of report.summary.split("\n").slice(0, pcfg.context?.reportMaxLines ?? 25)) log("  " + l);
  }
  if (report.logFile) log(c.dim(`\n      full transcript: ${path.relative(ROOT, report.logFile)}`));
  log("");
  process.exit(report.status === "done" ? 0 : 1);
}

// ─────────────────────────────── wave

async function cmdWave() {
  const cfg = loadConfig(ROOT);
  const pcfg = providersConfig(ROOT);
  const w = await import("../lib/wave.mjs");
  const res = await import("../lib/resources.mjs");
  const { collisions } = await import("../lib/team.mjs");

  const CONC = Number(arg("conc", pcfg.limits?.maxConcurrent || res.maxConcurrency({ ...res.DEFAULT_LIMITS, ...pcfg.limits })));
  const MAX = Number(arg("max", 99));
  const BUDGET = Number(arg("budget", pcfg.wave?.outputBudget || 4_000_000));
  const verifyCmds = arg("verify", null) ? [arg("verify")] : pcfg.wave?.verify || [];
  /**
   * Ход работ наружу, а не только в терминал.
   *
   * Надзирающий сервис не может узнать из итога, что происходит сейчас: кем
   * задача взята, какой это заход, критик принял или вернул, слияние прошло.
   * Опрос файлов задач это не заменяет — он отстаёт и не видит середины.
   */
  const events = w.eventLog(ROOT, { file: arg("events", null) });

  // Один экземпляр на проект: два берут одни задачи и дерутся за места.
  const lock = path.join(ROOT, ".agentkit", "state", ".wave.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (fs.existsSync(lock)) {
    const prev = Number(fs.readFileSync(lock, "utf8").trim());
    try {
      process.kill(prev, 0);
      err(`Волна уже идёт (pid ${prev}). Остановить: kill ${prev}`);
      process.exit(1);
    } catch {}
  }
  fs.writeFileSync(lock, String(process.pid), "utf8");
  const release = () => { try { fs.unlinkSync(lock); } catch {} };
  process.on("exit", release);

  const inFlight = new Map();
  const attempts = new Map();
  const results = [];
  let started = 0;
  let stopping = false;

  const stamp = () => new Date().toISOString().slice(11, 19);
  const say = (m) => log(`${c.dim(stamp())} ${m}`);

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      say(c.y(`⏹ остановка по ${sig}: ${inFlight.size} задач вернутся в очередь`));
      release();
      setTimeout(() => process.exit(130), 1500);
    });
  }

  const { windowUsage } = await import("../lib/usage.mjs");

  async function pump() {
    while (!stopping && started < MAX && inFlight.size < CONC) {
      const spent = windowUsage().totals.output;
      if (spent > BUDGET) {
        say(c.y(`⏸ окно подписки: ${spent.toLocaleString("ru")} из ${BUDGET.toLocaleString("ru")} — новых задач не беру`));
        return;
      }
      const list = w.ready(ROOT, loadTasks());
      const busyIds = [...inFlight.keys()];
      const busy = loadTasks().filter((t) => busyIds.includes(t.data.id));
      const queue = list.filter((t) => !busyIds.includes(t.data.id) && (attempts.get(t.data.id) || 0) < 3);
      if (!queue.length) return;

      // Две задачи в одном пакете дают не конфликт слияния, а два замысла.
      const t = queue.find((cand) => !busy.some((b) => collisions([{ id: cand.data.id, touches: cand.data.touches }, { id: b.data.id, touches: b.data.touches }]).length));
      if (!t) { say(c.dim(`⏳ ${queue[0].data.id} пересекается с работающей — жду`)); return; }

      started++;
      attempts.set(t.data.id, (attempts.get(t.data.id) || 0) + 1);
      say(`— беру ${c.b(t.data.id)} (в очереди ${queue.length}, в работе ${inFlight.size + 1})`);
      const p = w
        .carry(ROOT, { ...cfg, providers: pcfg }, t, { log: say, attempts, verifyCmds, onEvent: events.onEvent })
        .then((r) => {
          if (r.deferred) { started--; attempts.set(r.id, (attempts.get(r.id) || 1) - 1); }
          else results.push(r);
          return r;
        })
        .finally(() => inFlight.delete(t.data.id));
      inFlight.set(t.data.id, p);
    }
  }

  function loadTasks() {
    const dir = path.join(ROOT, "tasks", "tasks");
    return readDir(dir).map((f) => {
      const file = path.join(dir, f);
      const { data, body } = parseFront(fs.readFileSync(file, "utf8"));
      return { file, data, body };
    }).filter((t) => t.data.id).sort((a, b) => (a.data.id > b.data.id ? 1 : -1));
  }

  log(c.b("\n  agentkit wave"), c.dim(`· до ${CONC} одновременно · потолок окна ${BUDGET.toLocaleString("ru")}`));
  log(c.dim(`  события: ${path.relative(ROOT, events.file)}\n`));
  events.onEvent({ at: new Date().toISOString(), task: null, stage: "wave", event: "started", conc: CONC, budget: BUDGET, verify: verifyCmds });
  await pump();
  while (inFlight.size && !stopping) {
    await Promise.race([...inFlight.values()]);
    await pump();
  }
  release();
  events.onEvent({
    at: new Date().toISOString(),
    task: null,
    stage: "wave",
    event: "finished",
    started,
    results: results.map((r) => ({ task: r.id, result: r.result, needsIntegrator: Boolean(r.needsIntegrator) })),
  });
  log("");
  say(results.length ? `итог: ${results.map((r) => `${r.id} — ${r.result}`).join(" · ")}` : "очередь пуста, брать нечего");
  log("");
}

// ─────────────────────────────── team

const dur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}с` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const k = (n) => (n == null ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

async function cmdTeam() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const { gather, detail } = await import("../lib/team.mjs");
  const pcfg = providersConfig(ROOT);
  const who = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;

  if (who) {
    const d = detail(ROOT, who);
    if (has("json")) {
      if (!d.live && !d.task) { err(`не нашёл ни запуска, ни задачи «${who}»`); process.exit(1); }
      return json({ live: d.live || null, task: briefTask(d.task), past: d.past, verdict: d.verdict });
    }
    if (!d.live && !d.task) { err(`не нашёл ни запуска, ни задачи «${who}»`); process.exit(1); }
    log(c.b(`\n  ${who}`), c.dim(d.task?.title ? `· ${d.task.title}` : ""));
    log("");
    if (d.live) {
      log(`  ${c.g("работает")} ${d.live.role} · ${dur(d.live.elapsedMs)} · ${d.live.rssMB} МБ · ${k(d.live.tokens)} ток.`);
      log(c.dim(`  бокс ${d.live.branch || "—"} · pid ${d.live.pid} · ${d.live.provider}`));
    } else if (d.task) {
      log(`  ${c.dim("статус")} ${d.task.status} · ${d.task.owner || "—"} · риск ${d.task.risk || "—"}`);
    }
    if (d.past.length) {
      log("");
      log(c.dim("  прошлые запуски"));
      for (const r of d.past.slice(0, 6)) {
        log(`    ${String(r.role).padEnd(14)} ${String(r.status).padEnd(9)} ${k(r.usage?.total).padStart(6)} ${c.dim(String(r.reason || "").slice(0, 48))}`);
      }
    }
    if (d.verdict) {
      log("");
      log(c.dim("  последний вердикт критика"));
      for (const line of d.verdict.split("\n").filter((x) => x.trim()).slice(-6)) log(`    ${line.slice(0, 110)}`);
    }
    log("");
    return;
  }

  if (has("json")) {
    const g = gather(ROOT, pcfg);
    // `tasks` — это Map с телами задач: наблюдателю нужны срезы, а не архив.
    return json({
      project: cfg.project?.name ?? null,
      capacity: g.capacity,
      slots: g.slots,
      window: g.window,
      active: g.active,
      elsewhere: g.elsewhere,
      ready: g.ready.map(briefTask),
      waiting: g.waiting.map(briefTask),
      forHuman: g.forHuman.map(briefTask),
      merged: g.merged.map(briefTask),
      history: g.history,
    });
  }

  const draw = () => {
    const g = gather(ROOT, pcfg);
    const w = g.window;
    const out = [];
    out.push("");
    out.push(
      `  ${c.b(cfg.project?.name || "проект")}  ${c.dim(
        `окно ${k(w.output)} · память ${g.capacity.ramAvailGB} из ${g.capacity.ramTotalGB} ГБ · мест ${g.active.length}/${g.slots}${
          g.elsewhere ? ` · ещё ${g.elsewhere} в других проектах` : ""
        }`
      )}`
    );
    out.push("");

    out.push(c.b(`  В РАБОТЕ ${g.active.length}`));
    if (!g.active.length) out.push(c.dim("    никого"));
    for (const a of g.active) {
      out.push(
        `    ${c.g("●")} ${String(a.task || a.runId).padEnd(9)} ${String(a.role).padEnd(14)} ${String(a.title || "").slice(0, 34).padEnd(35)} ${dur(a.elapsedMs).padStart(6)} ${String(a.rssMB) + "МБ"} ${k(a.tokens).padStart(6)}`
      );
      out.push(c.dim(`      ${a.branch || "—"} · ${a.provider}${a.depth ? ` · глубина ${a.depth}` : ""}`));
    }

    out.push("");
    out.push(c.b(`  ГОТОВЫ ${g.ready.length}`) + c.dim(`  ·  ждут предшественника ${g.waiting.length}`));
    for (const r of g.ready.slice(0, 5)) {
      out.push(`    ${String(r.id).padEnd(9)} ${String(r.owner || "").padEnd(14)} ${String(r.title || "").slice(0, 50)}`);
    }

    if (g.forHuman.length) {
      out.push("");
      out.push(c.b(`  ${c.y("К ЧЕЛОВЕКУ")} ${g.forHuman.length}`) + c.dim("  приняты критиком, ждут решения"));
      for (const r of g.forHuman) {
        out.push(`    ${String(r.id).padEnd(9)} ${String(r.risk === "high" ? "риск" : "").padEnd(6)} ${String(r.title || "").slice(0, 56)}`);
      }
    }

    out.push("");
    out.push(c.b(`  В MAIN ${g.merged.length}`) + c.dim(`  из ${g.merged.length + g.forHuman.length + g.ready.length + g.waiting.length + g.active.length}`));

    if (g.history.length) {
      out.push("");
      out.push(c.dim("  последнее"));
      for (const h of g.history.slice(0, 5)) {
        const mark = h.status === "done" ? c.g("✓") : h.status === "killed" || h.status === "failed" ? c.r("✗") : c.y("!");
        out.push(
          c.dim(
            `    ${new Date(h.at).toISOString().slice(11, 16)} ${mark} ${String(h.task || h.runId).padEnd(9)} ${String(h.role).padEnd(13)} ${k(h.usage?.total).padStart(6)}`
          )
        );
      }
    }
    out.push("");
    return out.join("\n");
  };

  if (!has("watch")) { log(draw()); return; }

  const tick = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(draw() + "\n" + c.dim("  обновляется каждые 3 с · Ctrl+C выход\n"));
  };
  tick();
  const timer = setInterval(tick, 3000);
  process.on("SIGINT", () => { clearInterval(timer); process.stdout.write("\n"); process.exit(0); });
}

// ─────────────────────────────── adopt

/**
 * Take over a project that already has a hand-built `.claude/` and make it the
 * source instead of overwriting it. `init` would replace domain-specific agents
 * with generic templates; this keeps them and adds only what is missing.
 */
async function cmdAdopt() {
  const lang = arg("lang", "en");
  const t = messages(LANGS.includes(lang) ? lang : "en");
  const dest = path.join(ROOT, ".agentkit");
  const claude = path.join(ROOT, ".claude");
  const tpl = (...p) => path.join(PKG, "template", lang, ...p);

  log(c.b("\n  agentkit adopt"), c.dim(`· ${lang}\n`));

  if (!fs.existsSync(claude)) {
    err("nothing to adopt: there is no .claude/ here. Use: agentkit init");
    process.exit(1);
  }
  if (fs.existsSync(dest) && !has("force")) {
    err(".agentkit already exists — adopting again would overwrite it. Pass --force if that is what you want.");
    process.exit(1);
  }

  // A copy of what was there before anything is generated over it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = path.join(ROOT, `.claude.before-agentkit-${stamp}`);
  copyTree(claude, backup);
  ok(`backup: ${path.basename(backup)}`);

  // Existing definitions become the source of truth.
  const moved = { roles: 0, skills: 0, commands: 0, state: 0 };
  for (const [from, to, key] of [
    ["agents", "roles", "roles"],
    ["commands", "commands", "commands"],
  ]) {
    const src = path.join(claude, from);
    for (const f of readDir(src)) {
      if (copyIfAbsent(path.join(src, f), path.join(dest, to, f))) moved[key]++;
    }
  }
  // Claude Code keeps a skill as <name>/SKILL.md; the kit keeps it as <name>.md.
  const skillsDir = path.join(claude, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const file = e.isDirectory() ? path.join(skillsDir, e.name, "SKILL.md") : path.join(skillsDir, e.name);
      if (!fs.existsSync(file)) continue;
      const name = e.isDirectory() ? e.name : e.name.replace(/\.md$/, "");
      if (copyIfAbsent(file, path.join(dest, "skills", `${name}.md`))) moved.skills++;
    }
  }
  for (const f of readDir(path.join(claude, "state"))) {
    if (copyIfAbsent(path.join(claude, "state", f), path.join(dest, "state", f))) moved.state++;
  }
  ok(`adopted: ${moved.roles} roles · ${moved.skills} skills · ${moved.commands} commands · ${moved.state} memory files`);

  // Only what the project does not already have is added.
  let added = 0;
  for (const d of ["roles", "skills", "commands"]) {
    for (const f of readDir(tpl(d))) if (copyIfAbsent(tpl(d, f), path.join(dest, d, f))) added++;
  }
  copyTree(tpl("blocks"), path.join(dest, "blocks"));
  for (const f of readDir(tpl("memory"))) copyIfAbsent(tpl("memory", f), path.join(dest, "state", f));
  for (const f of readDir(tpl("human"))) copyIfAbsent(tpl("human", f), path.join(dest, f));
  for (const f of readDir(tpl("docs", "adr"))) copyIfAbsent(tpl("docs", "adr", f), path.join(ROOT, "docs", "adr", f));
  for (const f of readDir(tpl("tasks"))) copyIfAbsent(tpl("tasks", f), path.join(ROOT, "tasks", f));
  for (const d of ["epics", "features", "tasks", "done"]) fs.mkdirSync(path.join(ROOT, "tasks", d), { recursive: true });
  copyIfAbsent(path.join(PKG, "template", "providers.json"), path.join(dest, "providers.json"));
  ensureGitignore(ROOT, [".agentkit/state/runs/", ".agentkit/state/.providers-cache.json"]);
  ok(`added from the ${lang} templates: ${added} files the project did not have`);

  // Everything found is enabled: it was already in use before we arrived.
  const roles = {};
  for (const f of readDir(path.join(dest, "roles"))) {
    const { data } = parseFront(fs.readFileSync(path.join(dest, "roles", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    roles[name] = { enabled: true, cap: data.cap ?? 1 };
  }
  const adapters = arg("adapters", "claude-code").split(",").map((x) => x.trim());
  write(
    path.join(dest, "config.json"),
    JSON.stringify(
      { $schema: "./schema.json", version: 1, pack: "adopted", adapters, project: { name: path.basename(ROOT), language: lang }, roles },
      null,
      2
    ) + "\n"
  );
  ok(`config: ${Object.keys(roles).length} roles, all enabled`);

  await cmdSync(true);
  log(c.b("\n  Adopted.\n"));
  log("  Your own agents and skills are now the source in " + c.b(".agentkit/") + ";");
  log("  " + c.b(".claude/") + " is generated from them and will be overwritten by sync.");
  log(c.dim(`  If anything is missing, the untouched original is in ${path.basename(backup)}`));
  log("");
}

// ─────────────────────────────── account

async function cmdAccount() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const acc = await import("../lib/accounts.mjs");
  const { probeAll, get } = await import("../lib/providers/index.mjs");
  const sub = process.argv[3];
  const file = path.join(ROOT, ".agentkit", "providers.json");
  const pcfg = providersConfig(ROOT);

  log(c.b("\n  accounts\n"));

  if (sub === "add") {
    const provider = process.argv[4];
    const id = process.argv[5];
    if (!provider || !id) { err("account add <provider> <id>   e.g. account add cursor work"); process.exit(1); }
    const p = get(provider);
    if (!p) { err(`unknown provider "${provider}"`); process.exit(1); }
    if (!p.isolation) { err(`${provider} cannot hold more than one login`); process.exit(1); }
    if (pcfg.accounts.some((a) => a.id === id)) { err(`account "${id}" already exists`); process.exit(1); }

    const dir = acc.accountDir(`${provider}-${id}`);
    fs.mkdirSync(dir, { recursive: true });

    // Each vendor keeps its credential somewhere different; use what was measured.
    const entry = p.isolation === "home" ? { id, provider, home: dir } : { id, provider, configDir: dir };
    pcfg.accounts.push(entry);
    write(file, JSON.stringify(pcfg, null, 2) + "\n");

    ok(`${id} → ${provider}, kept apart by ${p.isolation === "home" ? "HOME" : p.configDirEnv} at ${dir}`);
    log("");
    log("  Log this account in — the browser flow runs once, in your own terminal:");
    log(c.b(`    ${p.isolation === "home" ? "HOME" : p.configDirEnv}=${dir} ${p.bin} login`));
    log("");
    if (p.isolation === "home") {
      warn("This CLI keeps its token in the system keychain, not in its config directory,");
      warn("so a second login needs its own HOME. Copy your ~/.gitconfig into it if the");
      warn("agent will commit:  cp ~/.gitconfig " + dir + "/");
    }
    log(c.dim("  Never set an API key for it: that path is metered and billed separately."));
    log("");
    log(c.dim("  Then check it took effect:  agentkit account list"));
    log(c.dim("  Two rows showing the same address mean the isolation did not work."));
    log("");
    return;
  }

  if (sub === "remove") {
    const id = process.argv[4];
    const before = pcfg.accounts.length;
    pcfg.accounts = pcfg.accounts.filter((a) => a.id !== id);
    if (pcfg.accounts.length === before) { err(`no account "${id}"`); process.exit(1); }
    write(file, JSON.stringify(pcfg, null, 2) + "\n");
    ok(`${id} removed from the roster. Its login directory was left in place.`);
    log("");
    return;
  }

  const probes = await probeAll({
    accounts: pcfg.accounts,
    cacheFile: path.join(ROOT, ".agentkit", "state", ".providers-cache.json"),
    ttlMs: 0,
  });
  const rows = acc.summary(ROOT, probes);
  if (!rows.length) {
    log(c.dim("  no accounts declared — each CLI's own login is used"));
    log(c.dim("  add one:  agentkit account add cursor work"));
    log("");
    return;
  }
  for (const r of rows) {
    const who = r.email || (r.loginPath === "token" ? "token from the environment" : "—");
    const line = `${String(r.id).padEnd(12)} ${r.provider.padEnd(12)} ${String(who).padEnd(26)} ${
      r.windowTokens ? Math.round(r.windowTokens / 1000) + "k this window" : "idle"
    }`;
    if (r.duplicateOf) err(`${line}  ${r.hint}`);
    else if (r.state === "ready") ok(line);
    else warn(`${line}  ${r.hint || r.state}`);
    if (r.cooldownUntil && r.cooldownUntil > Date.now()) {
      warn(`      resting until ${new Date(r.cooldownUntil).toISOString().slice(11, 16)}`);
    }
  }
  log("");
  log(c.dim("  Work goes to whichever login has spent the least in the current window."));
  log("");
}

// ─────────────────────────────── providers

async function cmdProviders() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const { probeAll, summary } = await import("../lib/providers/index.mjs");
  const { riskyEnvPresent } = await import("../lib/env.mjs");
  const acc = await import("../lib/accounts.mjs");

  const risky = riskyEnvPresent();
  const res = await probeAll({
    accounts: providersConfig(ROOT).accounts,
    cacheFile: path.join(ROOT, ".agentkit", "state", ".providers-cache.json"),
    ...(has("json") ? { ttlMs: 0 } : {}),
  });

  if (has("json")) {
    // Здесь лежат пределы и логины — то, ради чего сервис вообще спрашивает.
    return json({ probedAt: res.probedAt, riskyEnv: risky, providers: res.providers, accounts: acc.summary(ROOT, res) });
  }

  log(c.b(`\n  ${t.providersHeader}\n`));
  if (risky.length) err(t.riskyEnv(risky.join(", ")));

  const label = { ready: t.providersReady, "not-logged-in": t.providersNotLoggedIn, absent: t.providersAbsent, metered: t.providersMetered };
  for (const [id, p] of Object.entries(res.providers)) {
    const line = `${id.padEnd(14)} ${String(label[p.state] || p.state).padEnd(16)} ${p.capabilities.join(", ")}`;
    p.state === "ready" ? ok(line) : p.state === "metered" ? err(line) : warn(line);
    if (p.hint && p.state !== "ready") log(c.dim(`      → ${p.hint}`));
  }

  write(path.join(ROOT, ".agentkit", "state", "PROVIDERS.md"), summary(res));
  log("");
  log(c.dim("  " + t.providersCoreNote));
  ok(t.providersWritten);
  log("");
}

/**
 * Настройки провайдеров берутся из основного каталога проекта, а не из того,
 * откуда запущена команда.
 *
 * Рабочая копия задачи — это тот же репозиторий на другой ветке, и в ней лежит
 * своя копия `providers.json`, отставшая на момент ответвления. На живом прогоне
 * это дало запуск, упершийся в потолок, поднятый в основном каталоге минутой
 * ранее. Реестр запусков общий на машину — значит и лимиты должны читаться из
 * одного места.
 */
function projectRoot(root) {
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
    if (common) return path.dirname(common);
  } catch {}
  return root;
}

function providersConfig(root) {
  const f = path.join(projectRoot(root), ".agentkit", "providers.json");
  const fallback = { accounts: [], prefer: {}, roles: {}, limits: {}, context: {} };
  if (!fs.existsSync(f)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(f, "utf8")) };
  } catch {
    warn("providers.json is not valid JSON — using defaults");
    return fallback;
  }
}

// ─────────────────────────────── context

async function cmdContext() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const u = await import("../lib/usage.mjs");
  const res = await import("../lib/resources.mjs");

  const ctx = u.currentContext(ROOT);
  if (has("json")) {
    const cap = res.capacity(ROOT);
    const limits = { ...res.DEFAULT_LIMITS, ...providersConfig(ROOT).limits };
    return json({
      context: ctx || null,
      rotateAtPct: providersConfig(ROOT).context?.rotateAtPct ?? 60,
      capacity: cap,
      limits,
      maxConcurrent: res.maxConcurrency(limits, cap),
      admits: res.admits(0, limits, cap),
    });
  }

  log(c.b(`\n  ${t.contextHeader}\n`));
  if (!ctx) warn(t.contextNoData);
  else {
    const line = t.contextLine(u.fmt(ctx.tokens), u.fmt(ctx.window), ctx.pct);
    const limit = providersConfig(ROOT).context?.rotateAtPct ?? 60;
    ctx.pct >= limit ? warn(line) : ok(line);
    if (ctx.pct >= limit) warn(t.contextRotate(limit));
  }

  const cap = res.capacity(ROOT);
  const limits = { ...res.DEFAULT_LIMITS, ...providersConfig(ROOT).limits };
  log(c.dim("  " + t.capacityLine(cap)));
  const gate = res.admits(0, limits, cap);
  gate.ok ? log(c.dim("  " + t.concurrency(res.maxConcurrency(limits, cap)))) : warn(t.admitsNo(gate.reason));
  log("");
}

// ─────────────────────────────── usage

async function cmdUsage() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const u = await import("../lib/usage.mjs");
  if (has("json")) return json({ window: u.windowUsage(), today: u.today() });

  log(c.b(`\n  ${t.usageHeader}\n`));

  for (const [title, data] of [[t.usageWindow, u.windowUsage()], [t.usageToday, u.today()]]) {
    log(c.dim(`  ${title}`));
    const { totals } = data;
    log("    " + t.usageRow("output", u.fmt(totals.output)));
    log("    " + t.usageRow("input", u.fmt(totals.input)));
    log("    " + t.usageRow("cache read", u.fmt(totals.cacheRead)));
    log("    " + t.usageRow("cache write", u.fmt(totals.cacheCreate)));
    log("    " + t.usageRow("requests", u.fmt(totals.requests)));
    const models = Object.keys(data.byModel).filter((m) => m !== "unknown");
    if (models.length) log(c.dim(`    ${models.join(", ")}`));
    log("");
  }
}

// ─────────────────────────────── box

async function cmdBox() {
  const cfg = loadConfig(ROOT);
  const t = messages(cfg.project?.language);
  const boxes = await import("../lib/boxes.mjs");
  const sub = process.argv[3] || "list";

  if (has("json")) {
    if (sub !== "gc") return json(boxes.list(ROOT));
    const orch0 = await import("../lib/orchestrator.mjs");
    const busy = orch0.activeRuns(ROOT).map((r) => r.task || r.runId);
    const r = boxes.gc(ROOT, { keepDays: Number(arg("keep-days", 7)), force: has("force"), busy });
    return json({ ...r, transcripts: orch0.pruneRuns(ROOT) });
  }

  log(c.b(`\n  ${t.boxesHeader}\n`));

  if (sub === "gc") {
    const orch0 = await import("../lib/orchestrator.mjs");
    const busy = orch0.activeRuns(ROOT).map((r) => r.task || r.runId);
    const r = boxes.gc(ROOT, { keepDays: Number(arg("keep-days", 7)), force: has("force"), busy });
    for (const id of r.removed) ok(t.boxRemoved(id));
    for (const k of r.kept) warn(t.boxKept(k.taskId, k.reason));
    const p = orch0.pruneRuns(ROOT);
    if (p.removed) ok(`transcripts: ${p.removed} removed, ${p.freedMB} MB freed`);
    if (!r.removed.length && !r.kept.length) log(c.dim("  " + t.boxesEmpty));
  } else {
    const list = boxes.list(ROOT);
    if (!list.length) log(c.dim("  " + t.boxesEmpty));
    for (const b of list) {
      const state = [b.dirty ? "dirty" : null, b.ahead ? `+${b.ahead}` : null].filter(Boolean).join(" ");
      const note = b.note ? c.dim(" " + b.note) : "";
      log(`    ${String(b.taskId).padEnd(12)} ${String(b.mode || "?").padEnd(9)} ${String(b.branch || "—").padEnd(14)} ${String(b.sizeMB ?? 0) + "MB"} ${c.dim(state)}${note}`);
    }
  }
  log("");
}

// ─────────────────────────────── main

const cmd = process.argv[2];

if (cmd === "init") await cmdInit();
else if (cmd === "sync") await cmdSync(false);
else if (cmd === "doctor") await cmdDoctor();
else if (cmd === "status") cmdStatus();
else if (cmd === "role") cmdRole();
else if (cmd === "run" || cmd === "spawn") await cmdRun();
else if (cmd === "providers") await cmdProviders();
else if (cmd === "account" || cmd === "accounts") await cmdAccount();
else if (cmd === "adopt") await cmdAdopt();
else if (cmd === "team" || cmd === "who") await cmdTeam();
else if (cmd === "wave") await cmdWave();
else if (cmd === "context") await cmdContext();
else if (cmd === "usage") await cmdUsage();
else if (cmd === "box") await cmdBox();
else log(messages(resolveLang("en")).help(c.b));
