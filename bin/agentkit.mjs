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

  const report = await orch.run(ROOT, { ...cfg, providers: pcfg }, {
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
  });

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
    const line = `${String(r.id).padEnd(12)} ${r.provider.padEnd(12)} ${String(r.email || "—").padEnd(26)} ${
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

  log(c.b(`\n  ${t.providersHeader}\n`));

  const risky = riskyEnvPresent();
  if (risky.length) err(t.riskyEnv(risky.join(", ")));

  const res = await probeAll({
    accounts: providersConfig(ROOT).accounts,
    cacheFile: path.join(ROOT, ".agentkit", "state", ".providers-cache.json"),
  });

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

function providersConfig(root) {
  const f = path.join(root, ".agentkit", "providers.json");
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

  log(c.b(`\n  ${t.contextHeader}\n`));
  const ctx = u.currentContext(ROOT);
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
else if (cmd === "doctor") cmdDoctor();
else if (cmd === "status") cmdStatus();
else if (cmd === "role") cmdRole();
else if (cmd === "run" || cmd === "spawn") await cmdRun();
else if (cmd === "providers") await cmdProviders();
else if (cmd === "account" || cmd === "accounts") await cmdAccount();
else if (cmd === "adopt") await cmdAdopt();
else if (cmd === "context") await cmdContext();
else if (cmd === "usage") await cmdUsage();
else if (cmd === "box") await cmdBox();
else log(messages(resolveLang("en")).help(c.b));
