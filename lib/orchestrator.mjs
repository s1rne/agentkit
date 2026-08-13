import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readDir, parseFront, write } from "./util.mjs";
import { safeEnv, riskyEnvPresent } from "./env.mjs";
import { DEFAULT_LIMITS, admits, watch } from "./resources.mjs";
import * as boxes from "./boxes.mjs";
import { get, probeAll, route } from "./providers/index.mjs";
import * as accounts from "./accounts.mjs";

/**
 * Runs one agent as a child process of a subscription CLI and returns a REPORT.
 * The full transcript goes to disk; the caller gets a summary. That asymmetry is
 * the point: the lead's context is the scarcest resource in the system.
 */

export const MAX_DEPTH = 2;

/**
 * What an agent may do, decided by where it works — not by who it is.
 * Bypassing prompts is only ever allowed inside an isolated copy; that is the
 * whole reason boxes exist.
 */
export const PERMISSION_BY_BOX = {
  readonly: "read",
  shared: "edit",
  worktree: "isolated",
  sandbox: "isolated",
};

const runsDir = (root) => path.join(root, ".agentkit", "state", "runs");
/**
 * Machine-wide, not per repository: two projects on one laptop share one CPU and
 * one pool of RAM, and a per-repo counter would let each admit a full fleet.
 */
const activeFile = () => path.join(accounts.homeDir(), "active-runs.json");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readActive(root) {
  const f = activeFile();
  if (!fs.existsSync(f)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(list) ? list.filter((r) => r && r.pid && alive(r.pid)) : [];
  } catch {
    return [];
  }
}

/**
 * Runs alive right now. Dead entries are dropped on read: an agent killed with
 * SIGKILL never gets to remove its own row, and a stale row would shrink the
 * fleet by one forever.
 */
export function activeRuns(root) {
  const live = readActive(root);
  try {
    const raw = fs.existsSync(activeFile()) ? JSON.parse(fs.readFileSync(activeFile(), "utf8")) : [];
    if (Array.isArray(raw) && raw.length !== live.length) withLock(root, () => writeActive(root, readActive(root)));
  } catch {}
  return live;
}

/**
 * A nested agent runs its own orchestrator process, so the active list is shared
 * state between processes. Without a lock two of them read the same count, both
 * admit, and one write is lost — the entry vanishes and the count drifts upward
 * until the machine is over-subscribed. An exclusive-create lock file plus an
 * atomic rename is enough here and keeps the zero-dependency rule.
 */
/** A real sleep: spinning on Date.now() burns a core the fleet needs. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(root, fn) {
  const lock = activeFile() + ".lock";
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < 50; i++) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A crashed process must not block the fleet forever.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
      } catch {}
      sleep(20);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {}
    }
  }
  // Never block real work on bookkeeping.
  return fn();
}

function writeActive(root, list) {
  const f = activeFile();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, f);
}

export function trackActive(root, rec) {
  withLock(root, () => {
    const list = readActive(root).filter((r) => r.runId !== rec.runId);
    list.push(rec);
    writeActive(root, list);
  });
}

export function untrackActive(root, runId) {
  withLock(root, () => writeActive(root, readActive(root).filter((r) => r.runId !== runId)));
}

let seq = 0;
const newRunId = () => `R-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * The instruction that makes a child return a report instead of a transcript.
 * Written in the project's language: a report nobody on the team reads
 * comfortably is a report that gets skimmed.
 */
const REPORT_CONTRACT = {
  en: `
Your final message is the whole of what your caller will read — it is a report, not a conversation.
Write it in English. Keep it under 25 lines and use exactly these sections:
DONE: what you changed, file by file.
LEFT: anything unfinished or uncommitted, or "nothing".
FOUND: facts worth keeping that are not visible in the diff, or "nothing".
NEXT: what should happen next, or "nothing".
Do not restate the task. Do not paste code the caller can read in the diff.
`.trim(),
  ru: `
Твоё последнее сообщение — это всё, что прочитает вызвавший. Это отчёт, а не разговор.
Пиши по-русски. Не длиннее 25 строк, ровно эти разделы:
СДЕЛАНО: что изменено, по файлам.
ОСТАЛОСЬ: незавершённое и незакоммиченное, либо «ничего».
УЗНАЛ: факты, которые стоит сохранить и которых не видно в диффе, либо «ничего».
ДАЛЬШЕ: что должно произойти следом, либо «ничего».
Не пересказывай задачу. Не вставляй код, который вызвавший прочитает в диффе.
`.trim(),
};

export function composePrompt(root, { role, taskFile, instruction, language = "en" }) {
  const parts = [];
  const roleFile = path.join(root, ".agentkit", "roles", `${role}.md`);
  if (fs.existsSync(roleFile)) {
    const { body } = parseFront(fs.readFileSync(roleFile, "utf8"));
    parts.push(`You are acting as the \`${role}\` role. Its rules:\n\n${body.trim()}`);
  }
  const house = path.join(root, ".agentkit", "HOUSE-RULES.md");
  if (fs.existsSync(house)) parts.push(`Project house rules:\n\n${fs.readFileSync(house, "utf8").trim()}`);
  if (taskFile && fs.existsSync(taskFile)) parts.push(`Your task:\n\n${fs.readFileSync(taskFile, "utf8").trim()}`);
  if (instruction) parts.push(`Your task:\n\n${instruction}`);
  parts.push(REPORT_CONTRACT[language] || REPORT_CONTRACT.en);
  return parts.join("\n\n---\n\n");
}

/**
 * A role that declares no write tools cannot be given a writing box: forcing one
 * would hand it a permission mode its own definition denies. The role file is the
 * authority here, not a hard-coded list.
 */
export function roleWrites(root, role) {
  const f = path.join(root, ".agentkit", "roles", `${role}.md`);
  if (!fs.existsSync(f)) return true;
  const { data } = parseFront(fs.readFileSync(f, "utf8"));
  // parseFront yields an array only for `[a, b]`; a bare `a, b` stays a string.
  const tools = []
    .concat(data.tools || [])
    .flatMap((t) => String(t).split(","))
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tools.length) return true;
  return tools.some((t) => /^(Write|Edit|NotebookEdit)$/i.test(t));
}

/** Locate a task file by id anywhere under tasks/. */
export function findTask(root, taskId) {
  const base = path.join(root, "tasks");
  for (const d of ["tasks", "features", "epics", "done"]) {
    const dir = path.join(base, d);
    for (const f of readDir(dir)) {
      if (f.startsWith(taskId)) return path.join(dir, f);
    }
  }
  return null;
}

/**
 * @returns a report object. Never throws for an expected condition — a refusal is
 * a status, because a thrown error inside a fan-out loses the other agents' work.
 */
export async function run(root, cfg, opts) {
  const {
    task = null,
    role = "backend-dev",
    instruction = null,
    needs = ["code"],
    writers = 1,
    risk = "normal",
    kind = "normal",
    mode = null,
    depth = 0,
    parent = null,
    model = null,
    limits = DEFAULT_LIMITS,
    dryRun = false,
    onLine = null,
  } = opts;

  const runId = newRunId();
  const started = Date.now();
  const report = { runId, task, role, parent, depth, provider: null, model: null, box: null, status: "pending" };

  if (depth > MAX_DEPTH) {
    return { ...report, status: "refused", reason: `nesting depth ${depth} exceeds the cap of ${MAX_DEPTH}` };
  }

  const risky = riskyEnvPresent();
  if (risky.length) {
    return {
      ...report,
      status: "refused",
      reason: `metered API credentials in the environment (${risky.join(", ")}) — unset them; agents run on subscription CLIs only`,
    };
  }

  // Who can do this work at all.
  const probes = await probeAll({
    accounts: cfg.providers?.accounts || [],
    cacheFile: path.join(root, ".agentkit", "state", ".providers-cache.json"),
  });
  const routed = route(needs, probes, cfg.providers || {});
  if (!routed.provider) {
    return { ...report, status: "blocked", reason: routed.reason, needs, probes: probes.providers };
  }
  report.provider = routed.provider;
  report.model = model || routed.model || null;
  report.degraded = routed.degraded || false;
  report.degradedReason = routed.reason || null;

  // Does the machine have room right now.
  const gate = admits(activeRuns(root).length, limits);
  if (!gate.ok) return { ...report, status: "deferred", reason: gate.reason };

  // Where the work happens.
  const isGit = boxes.isGitRepo(root);
  const writes = roleWrites(root, role);
  const decided = mode
    ? { mode, reason: "set explicitly" }
    : !writes
      ? { mode: "readonly", reason: `the ${role} role declares no write tools` }
      : boxes.decideMode({ role, writers, risk, kind, isGit });
  let box;
  try {
    box = boxes.create(root, task || runId, decided.mode);
  } catch (e) {
    // Out of disk, or git refused. Deferring keeps the rest of the batch alive.
    return { ...report, status: "deferred", reason: e.message };
  }
  report.box = { mode: box.mode, path: box.path, branch: box.branch || null, reason: decided.reason };
  if (box.degradedFrom) report.box.degradedFrom = box.degradedFrom;

  /**
   * A box is reused by task id, so an existing worktree comes back even when this
   * agent was judged read-only. Permission follows the STRICTER of the two: a
   * reviewer must not gain write access just because an implementer's box exists.
   */
  const strictness = { read: 0, edit: 1, isolated: 2 };
  const wanted = PERMISSION_BY_BOX[decided.mode] || "edit";
  const given = PERMISSION_BY_BOX[box.mode] || "edit";
  const permission = strictness[wanted] <= strictness[given] ? wanted : given;
  report.box.permission = permission;
  if (!isGit && permission !== "read" && box.mode === "shared") {
    // Not an error: forcing a sandbox for every ordinary task would make the tool
    // unusable on an unversioned project. But there is no undo here, and silence
    // about that would be the dishonest part.
    report.box.warning = "this project is not under version control — an agent's edits cannot be undone; run git init";
  }

  const prompt = composePrompt(root, {
    role,
    taskFile: task ? findTask(root, task) : null,
    instruction,
    language: cfg.project?.language,
  });
  const provider = get(routed.provider);
  // Which login, when the vendor has more than one: least-loaded in this window.
  const account = accounts.pick(root, routed.provider, probes);
  report.account = account?.id || null;
  if (permission !== "read" && provider.sharedWriteSafe === false && box.mode === "shared") {
    return {
      ...report,
      status: "deferred",
      reason: `${provider.id} has no permission mode between read-only and run-everything, so it must not write in the working directory — rerun this task with --mode worktree`,
    };
  }

  let spec;
  try {
    spec = provider.spawnSpec({
      prompt,
      model: report.model,
      cwd: box.path,
      configDir: account?.configDir,
      home: account?.home,
      permission,
    });
  } catch (e) {
    // One unspawnable provider must not take down the rest of a fan-out.
    return { ...report, status: "blocked", reason: e.message };
  }

  if (dryRun) {
    // Eliding the prompt rather than truncating the line: the flags at the end —
    // above all the permission mode — are the only reason to run a dry run.
    const shown = [spec.cmd, ...spec.args.map((a) => (a.length > 60 ? `<prompt:${a.length}c>` : a))].join(" ");
    return { ...report, status: "dry-run", command: shown, promptChars: prompt.length };
  }

  fs.mkdirSync(runsDir(root), { recursive: true });
  const logFile = path.join(runsDir(root), `${runId}.jsonl`);
  const out = fs.createWriteStream(logFile);
  report.logFile = logFile;

  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: safeEnv(spec.env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  trackActive(root, { runId, pid: child.pid, root, task, role, provider: routed.provider, startedAt: started, parent, depth });

  let killed = null;
  const guard = watch(child.pid, {
    maxRssMB: limits.agentRssMB,
    maxMs: limits.maxAgentMinutes * 60_000,
    onKill: (reason) => {
      killed = reason;
    },
  });

  let stdout = "";
  let stderr = "";
  let pending = ""; // a JSON object can arrive split across two data events
  child.stdout.on("data", (b) => {
    const s = b.toString();
    stdout += s;
    out.write(s);
    if (!onLine) return;
    pending += s;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) onLine(l);
  });
  child.stderr.on("data", (b) => {
    stderr += b.toString();
  });

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });

  const peak = guard.peakRssMB();
  guard.stop();
  out.end();
  untrackActive(root, runId);

  const parsed = provider.parseStream(stdout);
  const durationMs = Date.now() - started;

  const finished = {
    ...report,
    status: killed ? "killed" : parsed.ok && code === 0 ? "done" : "failed",
    reason: killed || parsed.error || (code === 0 ? null : stderr.trim().split("\n")[0] || `exit ${code}`),
    summary: parsed.text || null,
    usage: parsed.usage || null,
    cost: parsed.cost ?? null,
    rateLimit: parsed.rateLimit || null,
    sessionId: parsed.sessionId || null,
    durationMs,
    peakRssMB: peak,
    exitCode: code,
  };

  // A run that failed because of the login, not the task, takes that login out of
  // rotation — otherwise every retry lands on the same exhausted subscription.
  const trouble = accounts.troubled(finished);
  if (account) {
    accounts.markUsed(root, account.id, { tokens: finished.usage?.total || 0, status: finished.status });
    if (trouble) accounts.cooldown(root, account.id, accounts.WINDOW_MS, trouble);
  }
  finished.accountTrouble = trouble;

  // The provider itself reports whether the run was billed per token. It should be
  // impossible after the env scrub, so if it happens the human must hear about it.
  if (parsed.metered) {
    finished.status = finished.status === "done" ? "done" : finished.status;
    finished.metered = true;
    finished.reason = `${finished.reason ? finished.reason + "; " : ""}this run authenticated as "${parsed.apiKeySource}", not a subscription login`;
  }

  writeRunRecord(root, finished);
  appendRunsMd(root, finished);
  appendReportToTask(root, finished, cfg.project?.language);

  // One retry on another login, never a loop.
  if (trouble && !opts._retried && account) {
    const next = accounts.pick(root, routed.provider, probes);
    if (next && next.id !== account.id) {
      return run(root, cfg, { ...opts, _retried: true });
    }
  }
  return finished;
}

/**
 * Transcripts are the biggest thing this system writes to disk — tens of
 * megabytes a day at a normal pace. Records outlive them: the JSON summary is
 * kept, the raw stream is not.
 */
export function pruneRuns(root, { keepDays = 14, keepLast = 50 } = {}) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return { removed: 0, freedMB: 0 };
  const cutoff = Date.now() - keepDays * 86_400_000;
  const active = new Set(activeRuns(root).map((r) => r.runId));

  const logs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { file: p, runId: f.replace(/\.jsonl$/, ""), mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  let freed = 0;
  logs.forEach((l, i) => {
    if (active.has(l.runId)) return;
    if (i < keepLast && l.mtime >= cutoff) return;
    try {
      fs.unlinkSync(l.file);
      removed++;
      freed += l.size;
    } catch {}
  });
  return { removed, freedMB: Math.round(freed / 1048576) };
}

const REPORT_HEADING = { en: "Run reports", ru: "Отчёты по запускам" };

/**
 * Append the report to the task file.
 *
 * Without this a reviewer's findings live only in the run log, while the author
 * reads the task file — so the next agent starts without them and the loop never
 * closes. Roles that can write put their report there themselves; a read-only
 * role like the critic cannot, and its findings are exactly the ones that must
 * survive. So the orchestrator writes it, for every role.
 */
export function appendReportToTask(root, r, language = "en") {
  if (!r.task || !r.summary) return false;
  const f = findTask(root, r.task);
  if (!f) return false;
  const head = REPORT_HEADING[language] || REPORT_HEADING.en;
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = `### ${r.role} · ${when} · ${r.status}${r.box?.branch ? ` · ${r.box.branch}` : ""}

${r.summary.trim()}
`;

  let text = fs.readFileSync(f, "utf8");
  if (text.includes(`## ${head}`)) {
    // Newest last: a task file is read top to bottom as a history.
    text = text.replace(/\s*$/, "\n\n") + entry;
  } else {
    text = text.replace(/\s*$/, "\n\n") + `## ${head}\n\n` + entry;
  }
  write(f, text);
  return true;
}

function writeRunRecord(root, r) {
  const f = path.join(runsDir(root), `${r.runId}.json`);
  const { summary, ...rest } = r;
  write(f, JSON.stringify({ ...rest, summary }, null, 2) + "\n");
}

const ROW = /^\|.*\|$/;

/** One line per run in the human-readable log. The detail stays in the JSON record. */
export function appendRunsMd(root, r) {
  const f = path.join(root, ".agentkit", "state", "RUNS.md");
  if (!fs.existsSync(f)) return;
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  const box = r.box ? `${r.box.mode}${r.box.branch ? ` ${r.box.branch}` : ""}` : "—";
  const tok = r.usage ? `${Math.round((r.usage.total || 0) / 1000)}k` : "—";
  const row = `| ${date} | ${r.role} | ${r.task || r.runId} | ${r.provider || "—"} · ${box} | ${r.status}${
    r.reason ? ` — ${String(r.reason).slice(0, 60)}` : ""
  } | ${tok} |`;

  const lines = fs.readFileSync(f, "utf8").split("\n");
  // Insert above the first existing data row, so newest stays on top.
  let at = lines.findIndex((l, i) => ROW.test(l) && i > 0 && /^\|[\s-:|]+\|$/.test(lines[i - 1]));
  if (at === -1) {
    // No table to write into: make one, rather than leaving a stray row after
    // whatever prose ends the file, where it stops being a table for good.
    lines.push("", "| Date | Role | Task | Provider · box | Outcome | Tokens |", "|---|---|---|---|---|---|", row);
  } else {
    if (/^\|\s*—/.test(lines[at])) lines.splice(at, 1);
    lines.splice(at, 0, row);
  }
  write(f, lines.join("\n"));
}
