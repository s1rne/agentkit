#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c, log, ok, warn, err, readDir, write, copyIfAbsent, parseFront, loadConfig, activeRoles } from "../lib/util.mjs";
import { messages, LANGS } from "../lib/i18n.mjs";

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

function cmdDoctor() {
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
  log(c.b(`\n  ${cfg.project?.name || t.project}`), c.dim(t.statusMeta(cfg.pack, cfg.adapters.join(", ")) + "\n"));

  const roles = activeRoles(ROOT, cfg);
  const byGroup = {};
  for (const r of roles) (byGroup[r.data.group || "—"] ||= []).push(r);
  for (const [g, list] of Object.entries(byGroup)) {
    log(c.dim(`  ${g}`));
    for (const r of list) log(`    ${r.name.padEnd(18)} ${c.dim(t.capUpTo(r.cfg.cap ?? r.data.cap ?? 1))}`);
  }
  const off = Object.entries(cfg.roles || {}).filter(([, v]) => v.enabled === false).map(([k]) => k);
  if (off.length) log(c.dim(`\n  ${t.disabled(off.join(", "))}`));

  const now = path.join(ROOT, ".agentkit", "state", "NOW.md");
  if (fs.existsSync(now)) {
    const line = fs.readFileSync(now, "utf8").split("\n").find((l) => l.startsWith("**") || (l.trim() && !l.startsWith("#") && !l.startsWith(">")));
    if (line) log(c.dim("\n  " + t.nowLabel) + line.replace(/\*\*/g, "").trim().slice(0, 90));
  }
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

// ─────────────────────────────── main

const cmd = process.argv[2];

if (cmd === "init") await cmdInit();
else if (cmd === "sync") await cmdSync(false);
else if (cmd === "doctor") cmdDoctor();
else if (cmd === "status") cmdStatus();
else if (cmd === "role") cmdRole();
else log(messages(resolveLang("en")).help(c.b));
