import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A box is the workspace an agent works in. The lead picks the mode per task and
 * writes it into the task file, so the implementer, the reviewer and the
 * integrator all see the same thing without asking.
 */
export const MODES = ["readonly", "shared", "worktree", "sandbox"];

/** Roles that only read. Callers may extend this list. */
export const READING_ROLES = ["critic", "security-auditor", "domain-analyst"];

/** Never copied into a sandbox: rebuildable, machine-local or huge. */
export const IGNORED = [
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "coverage", ".venv", "__pycache__", ".DS_Store",
];

/** A copy that would leave less free space than this is refused. */
const MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200000;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Run a command with an argument array — never a shell string. Failure is a value, not a throw. */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: opts.timeout ?? 20000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, out: (out || "").trim(), err: "", code: 0 };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "").trim(),
      err: String(e.stderr || e.message || "").trim(),
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

const git = (cwd, args, opts) => run("git", ["-C", cwd, ...args], opts);

export function isGitRepo(root) {
  if (!root || !fs.existsSync(root)) return false;
  const r = git(root, ["rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
  return r.ok && r.out === "true";
}

/** Basename of the project, safe to use as one path segment. */
/** Two checkouts can share a basename; the absolute path is what makes them distinct. */
function rootTag(root) {
  let h = 5381;
  const abs = path.resolve(root);
  for (let i = 0; i < abs.length; i++) h = ((h * 33) ^ abs.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

export function repoName(root) {
  const base = path.basename(path.resolve(root || "."));
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  // Without the tag, two checkouts both named "api" would share one box tree and
  // one agent would be handed another team's uncommitted work.
  return `${safe || "repo"}-${rootTag(root || ".")}`;
}

/** ~/.agentkit/boxes — outside the repository, so it never shows up in git status. */
export function boxesRoot() {
  const home = process.env.AGENTKIT_HOME || path.join(os.homedir(), ".agentkit");
  return path.join(home, "boxes");
}

function safeTaskId(taskId) {
  const id = String(taskId ?? "");
  if (!TASK_ID.test(id)) {
    throw new Error(`Bad task id ${JSON.stringify(id)}: allowed are letters, digits, dot, dash and underscore, first character not a dot.`);
  }
  return id;
}

function safeBranch(name) {
  const b = String(name ?? "");
  if (!BRANCH_NAME.test(b) || b.includes("..") || b.endsWith("/") || b.endsWith(".lock")) {
    throw new Error(`Bad branch name ${JSON.stringify(b)}.`);
  }
  return b;
}

const projectDir = (root) => path.join(boxesRoot(), repoName(root));
const metaDir = (root) => path.join(projectDir(root), ".meta");
const metaFile = (root, id) => path.join(metaDir(root), `${id}.json`);
const boxPath = (root, id) => path.join(projectDir(root), id);

function readMeta(root, id) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(root, id), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(root, meta) {
  fs.mkdirSync(metaDir(root), { recursive: true });
  fs.writeFileSync(metaFile(root, meta.taskId), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function dropMeta(root, id) {
  try {
    fs.rmSync(metaFile(root, id), { force: true });
  } catch {
    /* nothing to drop */
  }
}

/** Mark the box as used, so gc() measures idleness and not creation time. */
function touchMeta(root, id) {
  try {
    const now = new Date();
    fs.utimesSync(metaFile(root, id), now, now);
  } catch {
    /* the box may have no metadata yet */
  }
}

function lastUsed(root, id, dir) {
  let t = 0;
  for (const f of [metaFile(root, id), dir]) {
    try {
      t = Math.max(t, fs.statSync(f).mtimeMs);
    } catch {
      /* missing file contributes nothing */
    }
  }
  return t ? new Date(t).toISOString() : null;
}

/**
 * The lead's rule set. `writers` counts agents that will write CONCURRENTLY:
 * two of them in one directory collide over the git index, the build output and
 * the test run long before they collide over the same lines.
 */
export function decideMode({ role, writers = 1, risk = "normal", kind = "normal", isGit = true } = {}) {
  if (role && READING_ROLES.includes(role)) {
    return { mode: "readonly", reason: `Role ${role} only reads, so it works in the main directory with write tools withheld.` };
  }
  if (kind === "destructive") {
    return { mode: "sandbox", reason: "The operation is destructive, so it runs on a throwaway copy." };
  }
  const isolate =
    Number(writers) >= 2 || risk === "high" || kind === "migration" || kind === "mass-rewrite";
  if (isolate && !isGit) {
    return { mode: "sandbox", reason: "Isolation is needed but the project is not a git repository, so a plain copy is the only option." };
  }
  if (isolate) {
    const why =
      Number(writers) >= 2 ? `${writers} writers run at the same time`
        : risk === "high" ? "the task is marked risk: high"
          : `a ${kind} touches too much at once`;
    return { mode: "worktree", reason: `Isolated branch because ${why}.` };
  }
  return { mode: "shared", reason: "One writer on a normal task, so the main working directory is enough." };
}

function currentBranch(root) {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5000 });
  return r.ok && r.out && r.out !== "HEAD" ? r.out : "HEAD";
}

function branchExists(root, branch) {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { timeout: 5000 }).ok;
}

function isWorktreeOf(root, dir) {
  const r = git(root, ["worktree", "list", "--porcelain"], { timeout: 10000 });
  if (!r.ok) return false;
  const target = path.resolve(dir);
  return r.out.split(/\r?\n/).some((l) => l.startsWith("worktree ") && path.resolve(l.slice(9)) === target);
}

/** Size of a would-be sandbox copy, honouring the ignore list. */
function estimateSize(dir) {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORED.includes(e.name)) continue;
      if (++seen > MAX_WALK_ENTRIES) return { bytes, partial: true };
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return { bytes, partial: false };
}

/** Free bytes on the filesystem holding `dir`, or NaN when df is unreadable. */
function freeBytes(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const r = run("df", ["-Pk", probe], { timeout: 5000 });
  if (!r.ok) return NaN;
  const line = r.out.split(/\r?\n/)[1];
  const avail = line ? Number(line.trim().split(/\s+/)[3]) : NaN;
  return Number.isFinite(avail) ? avail * 1024 : NaN;
}

const gb = (n) => (n / (1024 * 1024 * 1024)).toFixed(1);

/** Recursive copy without the rebuildable and machine-local directories. */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (IGNORED.includes(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch {
        /* dangling or duplicate link */
      }
    } else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

function makeSandbox(root, id, note, degradedFrom) {
  const dest = boxPath(root, id);
  const { bytes, partial } = estimateSize(root);
  const free = freeBytes(path.dirname(dest));
  if (Number.isFinite(free) && free - bytes < MIN_FREE_BYTES) {
    throw new Error(
      `Refusing to build the sandbox for ${id}: the copy needs about ${gb(bytes)} GB${partial ? "+" : ""} and only ${gb(free)} GB are free, less than the ${gb(MIN_FREE_BYTES)} GB reserve.`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyTree(path.resolve(root), dest);
  const meta = {
    taskId: id, mode: "sandbox", path: dest, branch: null, base: null,
    root: path.resolve(root), degradedFrom: degradedFrom || null,
    note: note || null, createdAt: new Date().toISOString(),
  };
  writeMeta(root, meta);
  return { ...meta, created: true };
}

const shape = (meta, created) => ({
  taskId: meta.taskId,
  mode: meta.mode,
  path: meta.path,
  branch: meta.branch ?? null,
  created,
  degradedFrom: meta.degradedFrom ?? null,
  note: meta.note ?? null,
});

/**
 * Make (or find) the box for a task. Calling it twice for the same task id
 * returns the existing box instead of failing.
 */
export function create(root, taskId, mode, { branch, base } = {}) {
  const id = safeTaskId(taskId);
  if (!MODES.includes(mode)) throw new Error(`Unknown box mode ${JSON.stringify(mode)}; expected one of ${MODES.join(", ")}.`);
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) throw new Error(`No such project directory: ${abs}`);

  const known = readMeta(root, id);
  if (known && (known.mode === "readonly" || known.mode === "shared" || fs.existsSync(known.path))) {
    touchMeta(root, id);
    return shape(known, false);
  }

  if (mode === "readonly" || mode === "shared") {
    const meta = {
      taskId: id, mode, path: abs, branch: null, base: null, root: abs,
      degradedFrom: null,
      note: mode === "readonly" ? "Write tools must be withheld by the caller." : null,
      createdAt: new Date().toISOString(),
    };
    writeMeta(root, meta);
    return shape(meta, false);
  }

  if (mode === "sandbox") return shape(makeSandbox(root, id, null, null), true);

  // worktree
  if (!isGitRepo(abs)) {
    const note = `${abs} is not a git repository, so the isolated branch became a plain copy; carry results back by hand.`;
    return shape(makeSandbox(root, id, note, "worktree"), true);
  }
  const name = branch ? safeBranch(branch) : `ak/${id}`;
  const start = base ? String(base) : "HEAD";
  const dest = boxPath(root, id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(abs, ["worktree", "prune"], { timeout: 10000 });

  if (fs.existsSync(dest) && isWorktreeOf(abs, dest)) {
    const meta = readMeta(root, id) || {
      taskId: id, mode: "worktree", path: dest, branch: name,
      base: base || currentBranch(abs), root: abs, degradedFrom: null,
      note: "Adopted an existing worktree.", createdAt: new Date().toISOString(),
    };
    writeMeta(root, meta);
    return shape(meta, false);
  }

  const reuse = branchExists(abs, name);
  const args = reuse
    ? ["worktree", "add", dest, name]
    : ["worktree", "add", "-b", name, dest, start];
  const r = git(abs, args, { timeout: 60000 });
  if (!r.ok) throw new Error(`git worktree add failed for ${id}: ${r.err || r.out || `exit ${r.code}`}`);

  const meta = {
    taskId: id, mode: "worktree", path: dest, branch: name,
    base: base || currentBranch(abs), root: abs, degradedFrom: null,
    note: reuse ? `Reused the existing branch ${name}.` : null,
    createdAt: new Date().toISOString(),
  };
  writeMeta(root, meta);
  return shape(meta, true);
}

/** Uncommitted work and distance from the base, as far as git can tell. */
function worktreeState(meta) {
  const state = { dirty: false, ahead: 0, behind: 0 };
  if (!meta || meta.mode !== "worktree" || !fs.existsSync(meta.path)) return state;
  const st = git(meta.path, ["status", "--porcelain"], { timeout: 15000 });
  state.dirty = st.ok ? st.out !== "" : true;
  const base = meta.base && meta.base !== "HEAD" ? meta.base : null;
  if (base && meta.branch) {
    const r = git(meta.path, ["rev-list", "--left-right", "--count", `${base}...${meta.branch}`], { timeout: 15000 });
    if (r.ok) {
      const [behind, ahead] = r.out.split(/\s+/).map(Number);
      if (Number.isFinite(behind)) state.behind = behind;
      if (Number.isFinite(ahead)) state.ahead = ahead;
    }
  }
  return state;
}

function sizeMB(dir) {
  if (!fs.existsSync(dir)) return 0;
  const r = run("du", ["-skx", dir], { timeout: 10000 });
  if (!r.ok) return 0;
  const kb = Number(r.out.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
}

/** Every box registered for this project. Never throws — a broken box is reported, not raised. */
export function list(root) {
  let files = [];
  try {
    files = fs.readdirSync(metaDir(root)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    const id = f.replace(/\.json$/, "");
    const meta = readMeta(root, id);
    if (!meta) {
      out.push({ taskId: id, mode: null, path: null, branch: null, sizeMB: 0, ahead: 0, behind: 0, dirty: false, lastUsed: null, note: "unreadable metadata" });
      continue;
    }
    const own = meta.mode === "worktree" || meta.mode === "sandbox";
    const gone = own && !fs.existsSync(meta.path);
    const st = gone ? { dirty: false, ahead: 0, behind: 0 } : worktreeState(meta);
    out.push({
      taskId: meta.taskId,
      mode: meta.mode,
      path: meta.path,
      branch: meta.branch ?? null,
      sizeMB: own && !gone ? sizeMB(meta.path) : 0,
      ahead: st.ahead,
      behind: st.behind,
      dirty: st.dirty,
      lastUsed: lastUsed(root, id, own ? meta.path : null),
      note: gone ? "directory is gone" : meta.note ?? null,
    });
  }
  return out;
}

/**
 * Losing an agent's work silently is the worst thing this module could do, so a
 * dirty or unmerged worktree is refused unless the caller insists.
 */
export function remove(root, taskId, { force = false } = {}) {
  const id = safeTaskId(taskId);
  const meta = readMeta(root, id);
  if (!meta) return { removed: false, reason: `No box is registered for ${id}.` };

  if (meta.mode === "readonly" || meta.mode === "shared") {
    dropMeta(root, id);
    return { removed: true, reason: `A ${meta.mode} box owns no directory; only the record was dropped.` };
  }
  if (path.resolve(meta.path) === path.resolve(meta.root || root)) {
    return { removed: false, reason: "Refusing to delete the main working directory." };
  }
  if (!fs.existsSync(meta.path)) {
    dropMeta(root, id);
    return { removed: true, reason: "The directory was already gone; the record was dropped." };
  }

  // A sandbox has no version control behind it: whatever an agent produced there
  // exists nowhere else. Deleting it is unrecoverable, so it is never automatic.
  if (meta.mode === "sandbox" && !force) {
    return {
      removed: false,
      reason: `Sandbox ${id} is not under version control, so nothing in it can be recovered; pass force to delete.`,
    };
  }

  if (meta.mode === "worktree" && !force) {
    const st = worktreeState(meta);
    if (st.dirty) return { removed: false, reason: `Worktree ${id} has uncommitted changes; commit them or pass force.` };
    if (st.ahead > 0) return { removed: false, reason: `Branch ${meta.branch} is ${st.ahead} commit(s) ahead of ${meta.base}; merge it or pass force.` };
  }

  if (meta.mode === "worktree") {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), meta.path];
    const r = git(meta.root || root, args, { timeout: 30000 });
    if (!r.ok) {
      if (!force) return { removed: false, reason: `git worktree remove refused: ${r.err || r.out || `exit ${r.code}`}` };
      fs.rmSync(meta.path, { recursive: true, force: true });
      git(meta.root || root, ["worktree", "prune"], { timeout: 10000 });
    }
  } else {
    fs.rmSync(meta.path, { recursive: true, force: true });
  }
  dropMeta(root, id);
  return { removed: true, reason: `Removed the ${meta.mode} box for ${id}.` };
}

/** Drop boxes nobody has touched for a while, under the same refusal rules. */
export function gc(root, { keepDays = 7, force = false, busy = [] } = {}) {
  const running = new Set(busy.map(String));
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  const kept = [];
  for (const box of list(root)) {
    // A box whose task is still running is not garbage, however old it looks.
    if (running.has(String(box.taskId))) {
      kept.push({ taskId: box.taskId, reason: "An agent is working in it right now." });
      continue;
    }
    const used = box.lastUsed ? Date.parse(box.lastUsed) : 0;
    if (used && used > cutoff) {
      kept.push({ taskId: box.taskId, reason: `Used ${new Date(used).toISOString()}, within ${keepDays} day(s).` });
      continue;
    }
    const r = remove(root, box.taskId, { force });
    if (r.removed) removed.push(box.taskId);
    else kept.push({ taskId: box.taskId, reason: r.reason });
  }
  return { removed, kept };
}

/** What an integrator needs to decide whether a branch can go home. Never throws. */
export function mergeStatus(root, taskId) {
  const empty = { branch: null, merged: false, ahead: 0, behind: 0, conflictsWith: [] };
  let meta;
  try {
    meta = readMeta(root, safeTaskId(taskId));
  } catch {
    return { ...empty, note: "bad task id" };
  }
  if (!meta) return { ...empty, note: "no such box" };
  if (meta.mode !== "worktree" || !meta.branch) {
    return { ...empty, note: `A ${meta.mode} box has no branch to merge.` };
  }
  const repo = fs.existsSync(meta.root || "") ? meta.root : path.resolve(root);
  const base = meta.base && meta.base !== "HEAD" ? meta.base : currentBranch(repo);
  const st = worktreeState({ ...meta, base });
  const anc = git(repo, ["merge-base", "--is-ancestor", meta.branch, base], { timeout: 15000 });
  const merged = anc.ok;

  let conflictsWith = [];
  if (!merged) {
    const mt = git(repo, ["merge-tree", "--write-tree", "--name-only", base, meta.branch], { timeout: 30000 });
    if (!mt.ok && mt.code === 1) {
      // exit 1 means conflicts: line 0 is the tree oid, then paths, then a blank line and messages
      const lines = mt.out.split(/\r?\n/).slice(1);
      const end = lines.indexOf("");
      conflictsWith = (end === -1 ? lines : lines.slice(0, end)).filter(Boolean);
    }
  }
  return { branch: meta.branch, merged, ahead: st.ahead, behind: st.behind, conflictsWith };
}
