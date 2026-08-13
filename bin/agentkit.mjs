#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c, log, ok, warn, err, readDir, write, copyIfAbsent, parseFront, loadConfig, activeRoles } from "../lib/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const ROOT = process.cwd();

const ADAPTERS = {
  "claude-code": () => import("../lib/adapters/claude-code.mjs"),
  cursor: () => import("../lib/adapters/cursor.mjs"),
  "agents-md": () => import("../lib/adapters/agents-md.mjs"),
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (f) => process.argv.includes(`--${f}`);

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
  const packName = arg("pack", "base");
  const adapters = arg("adapters", "claude-code").split(",").map((s) => s.trim());
  const dest = path.join(ROOT, ".agentkit");

  if (fs.existsSync(dest) && !has("force")) {
    err(".agentkit уже существует. Обновить конфиги: npx agent-kit sync. Переустановить: --force");
    process.exit(1);
  }

  const packFile = path.join(PKG, "packs", `${packName}.json`);
  if (!fs.existsSync(packFile)) {
    err(`Нет пака «${packName}». Доступны: ${fs.readdirSync(path.join(PKG, "packs")).map((f) => f.replace(".json", "")).join(", ")}`);
    process.exit(1);
  }
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));

  log(c.b("\n  agentkit init"), c.dim(`· пак ${packName} · ${adapters.join(", ")}\n`));

  // ядро: роли, навыки, команды — перезаписываются
  for (const d of ["roles", "skills", "commands"]) {
    copyTree(path.join(PKG, "template", d), path.join(dest, d));
  }
  ok("ядро скопировано в .agentkit/");

  // память, интерфейс человека, задачи — только если ещё нет: это состояние проекта
  let kept = 0;
  for (const f of readDir(path.join(PKG, "template", "memory"))) {
    if (!copyIfAbsent(path.join(PKG, "template", "memory", f), path.join(dest, "state", f))) kept++;
  }
  for (const f of readDir(path.join(PKG, "template", "human"))) {
    copyIfAbsent(path.join(PKG, "template", "human", f), path.join(dest, f));
  }
  for (const f of readDir(path.join(PKG, "template", "docs", "adr"))) {
    copyIfAbsent(path.join(PKG, "template", "docs", "adr", f), path.join(ROOT, "docs", "adr", f));
  }
  for (const f of readDir(path.join(PKG, "template", "tasks"))) {
    copyIfAbsent(path.join(PKG, "template", "tasks", f), path.join(ROOT, "tasks", f));
  }
  for (const d of ["epics", "features", "tasks", "done"]) {
    fs.mkdirSync(path.join(ROOT, "tasks", d), { recursive: true });
  }
  ok(kept ? `память создана (${kept} файлов уже были — сохранены)` : "память создана: .agentkit/state/");
  ok("интерфейс человека: PROJECT.md · HOUSE-RULES.md · INBOX.md · QUESTIONS.md");
  ok("задачи: tasks/  ·  ADR: docs/adr/");

  // конфиг
  const roles = {};
  for (const f of readDir(path.join(dest, "roles"))) {
    const { data } = parseFront(fs.readFileSync(path.join(dest, "roles", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    const on = pack.roles.includes(name);
    roles[name] = { enabled: on, cap: data.cap ?? 1, ...(on ? {} : { reason: "не входит в пак " + packName }) };
  }
  write(
    path.join(dest, "config.json"),
    JSON.stringify(
      { $schema: "./schema.json", version: 1, pack: packName, adapters, project: { name: path.basename(ROOT), language: "ru" }, roles },
      null,
      2
    ) + "\n"
  );
  ok("конфиг: .agentkit/config.json");

  await cmdSync(true);

  log(c.b("\n  Готово.\n"));
  log("  Дальше — заполни три файла, остальное система сделает сама:");
  log(c.dim("    1.") + " .agentkit/PROJECT.md      что за проект, для кого, словарь терминов");
  log(c.dim("    2.") + " .agentkit/HOUSE-RULES.md  как работать: инструменты, процесс, границы");
  log(c.dim("    3.") + " .agentkit/state/NOW.md    где вы сейчас");
  log("");
  log("  Затем в новой сессии: " + c.b("/boot") + "\n");
}

// ─────────────────────────────── sync

async function cmdSync(quiet) {
  const cfg = loadConfig(ROOT);
  if (!quiet) log(c.b("\n  agentkit sync\n"));
  for (const a of cfg.adapters) {
    const loader = ADAPTERS[a];
    if (!loader) { warn(`неизвестный адаптер «${a}» — пропущен`); continue; }
    const mod = await loader();
    mod.generate(ROOT, cfg);
  }
  if (!quiet) log("");
}

// ─────────────────────────────── doctor

function cmdDoctor() {
  log(c.b("\n  agentkit doctor\n"));
  const cfg = loadConfig(ROOT);
  let problems = 0;
  const fail = (m) => { err(m); problems++; };

  // память
  for (const f of ["BOOT.md", "NOW.md", "JOURNAL.md", "DECISIONS.md", "TEAM.md", "RUNS.md"]) {
    fs.existsSync(path.join(ROOT, ".agentkit", "state", f)) ? ok(`память: ${f}`) : fail(`нет .agentkit/state/${f}`);
  }

  // интерфейс человека
  for (const f of ["PROJECT.md", "HOUSE-RULES.md", "INBOX.md", "QUESTIONS.md"]) {
    fs.existsSync(path.join(ROOT, ".agentkit", f)) ? ok(`интерфейс человека: ${f}`) : fail(`нет .agentkit/${f}`);
  }
  const proj = path.join(ROOT, ".agentkit", "PROJECT.md");
  if (fs.existsSync(proj) && fs.readFileSync(proj, "utf8").includes("<!-- Одним абзацем")) {
    warn("PROJECT.md не заполнен — команда работает вслепую");
  }

  // роли из конфига существуют
  const files = new Set(readDir(path.join(ROOT, ".agentkit", "roles")).map((f) => f.replace(/\.md$/, "")));
  for (const name of Object.keys(cfg.roles || {})) {
    if (!files.has(name)) fail(`роль «${name}» в конфиге, но нет .agentkit/roles/${name}.md`);
  }

  // навыки, на которые ссылаются роли
  const skills = new Set(readDir(path.join(ROOT, ".agentkit", "skills")).map((f) => f.replace(/\.md$/, "")));
  for (const r of activeRoles(ROOT, cfg)) {
    for (const s of [].concat(r.data.skills || [])) {
      if (s && !skills.has(s)) fail(`роль «${r.name}» ссылается на несуществующий навык «${s}»`);
    }
  }

  // NOW не должен остаться шаблоном
  const now = path.join(ROOT, ".agentkit", "state", "NOW.md");
  if (fs.existsSync(now) && fs.readFileSync(now, "utf8").includes("ЗАПОЛНИ")) {
    warn("NOW.md не заполнен — холодный старт даст пустоту");
  }

  // сгенерированное новее исходников?
  const claudeAgents = path.join(ROOT, ".claude", "agents");
  if (cfg.adapters.includes("claude-code") && fs.existsSync(claudeAgents)) {
    const srcM = Math.max(...readDir(path.join(ROOT, ".agentkit", "roles")).map((f) => fs.statSync(path.join(ROOT, ".agentkit", "roles", f)).mtimeMs), 0);
    const genM = Math.min(...readDir(claudeAgents).map((f) => fs.statSync(path.join(claudeAgents, f)).mtimeMs), Infinity);
    if (srcM > genM) warn("исходники .agentkit/ новее сгенерированного — выполни: npx agent-kit sync");
  }

  const active = activeRoles(ROOT, cfg).length;
  log("");
  log(problems ? c.r(`  ${problems} проблем`) : c.g("  Проблем нет.") + c.dim(`  Ролей активно: ${active}`));
  log("");
  process.exit(problems ? 1 : 0);
}

// ─────────────────────────────── status

function cmdStatus() {
  const cfg = loadConfig(ROOT);
  log(c.b(`\n  ${cfg.project?.name || "проект"}`), c.dim(`· пак ${cfg.pack} · ${cfg.adapters.join(", ")}\n`));

  const roles = activeRoles(ROOT, cfg);
  const byGroup = {};
  for (const r of roles) (byGroup[r.data.group || "прочее"] ||= []).push(r);
  for (const [g, list] of Object.entries(byGroup)) {
    log(c.dim(`  ${g}`));
    for (const r of list) log(`    ${r.name.padEnd(18)} ${c.dim("экз. до " + (r.cfg.cap ?? r.data.cap ?? 1))}`);
  }
  const off = Object.entries(cfg.roles || {}).filter(([, v]) => v.enabled === false).map(([k]) => k);
  if (off.length) log(c.dim(`\n  выключены: ${off.join(", ")}`));

  const now = path.join(ROOT, ".agentkit", "state", "NOW.md");
  if (fs.existsSync(now)) {
    const line = fs.readFileSync(now, "utf8").split("\n").find((l) => l.startsWith("**") || (l.trim() && !l.startsWith("#") && !l.startsWith(">")));
    if (line) log(c.dim("\n  сейчас: ") + line.replace(/\*\*/g, "").trim().slice(0, 90));
  }
  log("");
}

// ─────────────────────────────── role

function cmdRole() {
  const [, , , sub, name, val] = process.argv;
  const cfgPath = path.join(ROOT, ".agentkit", "config.json");
  const cfg = loadConfig(ROOT);
  if (!name) { err("нужно имя роли"); process.exit(1); }
  cfg.roles[name] ||= { enabled: false, cap: 1 };

  if (sub === "enable") { cfg.roles[name].enabled = true; delete cfg.roles[name].reason; ok(`${name} включена`); }
  else if (sub === "disable") { cfg.roles[name].enabled = false; ok(`${name} выключена`); }
  else if (sub === "cap") { cfg.roles[name].cap = Number(val); ok(`${name}: потолок ${val}`); }
  else { err("role enable|disable|cap <имя> [n]"); process.exit(1); }

  write(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  warn("не забудь: npx agent-kit sync");
}

// ─────────────────────────────── main

const cmd = process.argv[2];
const help = `
  ${c.b("agent-kit")} — команда ИИ-агентов, память и процессы разработки в любом проекте

  ${c.b("npx agent-kit init")} [--pack base|web-product] [--adapters claude-code,cursor,agents-md] [--force]
  ${c.b("npx agent-kit sync")}      перегенерировать конфиги инструментов из .agentkit/
  ${c.b("npx agent-kit doctor")}    проверить целостность
  ${c.b("npx agent-kit status")}    штат команды и текущее состояние
  ${c.b("npx agent-kit role")} enable|disable|cap <роль> [n]

  Правь ${c.b(".agentkit/")}, не сгенерированные .claude/ и .cursor/ — их затрёт sync.
`;

if (cmd === "init") await cmdInit();
else if (cmd === "sync") await cmdSync(false);
else if (cmd === "doctor") cmdDoctor();
else if (cmd === "status") cmdStatus();
else if (cmd === "role") cmdRole();
else log(help);
