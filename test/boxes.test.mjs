import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Boxes must never land in the real ~/.agentkit while tests run.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ak-home-"));
process.env.AGENTKIT_HOME = HOME;

const { decideMode, create, list, remove, gc, boxesRoot, isGitRepo, repoName } = await import("../lib/boxes.mjs");

const trash = [HOME];
after(() => {
  for (const d of trash) fs.rmSync(d, { recursive: true, force: true });
});

// Identity is set inline so the tests do not depend on global git config.
const IDENT = ["-c", "user.email=test@example.invalid", "-c", "user.name=agentkit test",
               "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...IDENT, ...args], { encoding: "utf8" });
const real = (p) => fs.realpathSync(p);

function tmp(prefix = "ak-box-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function repo() {
  const dir = tmp("ak-repo-");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

test("decideMode follows the lead's rules", () => {
  assert.equal(decideMode({ role: "critic" }).mode, "readonly");
  assert.equal(decideMode({ role: "backend-dev", writers: 1 }).mode, "shared");
  assert.equal(decideMode({ role: "backend-dev", writers: 2 }).mode, "worktree");
  assert.equal(decideMode({ role: "backend-dev", writers: 1, risk: "high" }).mode, "worktree");
  assert.equal(decideMode({ role: "data-engineer", writers: 1, kind: "migration" }).mode, "worktree");
  assert.equal(decideMode({ role: "backend-dev", writers: 2, isGit: false }).mode, "sandbox");
  assert.equal(decideMode({ role: "backend-dev", kind: "destructive" }).mode, "sandbox");
  // architect and planner produce artefacts (ADRs, task files) — a read-only box
  // would hand them a permission mode their own role definition contradicts.
  for (const role of ["security-auditor", "domain-analyst"]) {
    assert.equal(decideMode({ role, writers: 3, risk: "high" }).mode, "readonly", role);
  }
  assert.ok(decideMode({ role: "backend-dev", writers: 2 }).reason.length > 10, "reason must be writable into a task file");
});

test("a worktree box is a real branch outside the repository", () => {
  const root = repo();
  assert.ok(isGitRepo(root));
  const box = create(root, "T-0001", "worktree");

  assert.equal(box.mode, "worktree");
  assert.equal(box.branch, "ak/T-0001");
  assert.equal(box.created, true);
  assert.equal(box.degradedFrom, null);
  assert.equal(real(box.path), real(path.join(boxesRoot(), repoName(root), "T-0001")));
  assert.ok(!real(box.path).startsWith(real(root)), "a box inside the repo would show up in git status");
  assert.ok(fs.existsSync(path.join(box.path, "README.md")));

  const listed = git(root, "worktree", "list", "--porcelain")
    .split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9)));
  assert.ok(listed.includes(real(box.path)), "git does not know about the worktree");
  assert.ok(git(root, "branch", "--list", "ak/T-0001").includes("ak/T-0001"));

  const again = create(root, "T-0001", "worktree");
  assert.equal(again.created, false, "create must be idempotent");
  assert.equal(again.path, box.path);
  assert.equal(again.branch, "ak/T-0001");
});

test("list reports mode, branch and cleanliness", () => {
  const root = repo();
  create(root, "T-0002", "worktree");
  const rows = list(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, "T-0002");
  assert.equal(rows[0].mode, "worktree");
  assert.equal(rows[0].branch, "ak/T-0002");
  assert.equal(rows[0].dirty, false);
  assert.equal(rows[0].ahead, 0);
  assert.ok(typeof rows[0].sizeMB === "number");
  assert.ok(rows[0].lastUsed, "lastUsed drives gc");
});

test("without git a worktree degrades to a sandbox instead of failing", () => {
  const root = tmp("ak-plain-");
  fs.writeFileSync(path.join(root, "file.txt"), "data\n");
  assert.equal(isGitRepo(root), false);

  const box = create(root, "T-0003", "worktree");
  assert.equal(box.mode, "sandbox");
  assert.equal(box.degradedFrom, "worktree");
  assert.equal(box.branch, null);
  assert.match(box.note, /not a git repository/);
  assert.ok(fs.existsSync(path.join(box.path, "file.txt")));
});

test("a sandbox copy leaves the rebuildable directories behind", () => {
  const root = tmp("ak-plain-");
  fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "// big\n");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "// built\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "// source\n");

  const box = create(root, "T-0004", "sandbox");
  assert.equal(box.mode, "sandbox");
  assert.ok(fs.existsSync(path.join(box.path, "src", "app.js")), "source must be copied");
  assert.equal(fs.existsSync(path.join(box.path, "node_modules")), false, "node_modules must not be copied");
  assert.equal(fs.existsSync(path.join(box.path, "dist")), false, "build output must not be copied");
});

test("shared and readonly boxes stay in the working directory", () => {
  const root = repo();
  const shared = create(root, "T-0005", "shared");
  assert.equal(shared.path, path.resolve(root));
  assert.equal(shared.created, false);
  assert.equal(shared.branch, null);

  const ro = create(root, "T-0006", "readonly");
  assert.equal(ro.path, path.resolve(root));
  assert.equal(ro.created, false);

  const r = remove(root, "T-0005");
  assert.equal(r.removed, true);
  assert.ok(fs.existsSync(root), "removing a shared box must never touch the working directory");
});

test("remove refuses to throw away uncommitted work", () => {
  const root = repo();
  const box = create(root, "T-0007", "worktree");
  fs.writeFileSync(path.join(box.path, "notes.md"), "work in progress\n");

  const refused = remove(root, "T-0007");
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /uncommitted/i);
  assert.ok(fs.existsSync(box.path), "the box must survive a refusal");

  const forced = remove(root, "T-0007", { force: true });
  assert.equal(forced.removed, true);
  assert.equal(fs.existsSync(box.path), false);
  assert.equal(list(root).length, 0);
});

test("remove refuses a branch that is ahead of its base", () => {
  const root = repo();
  const box = create(root, "T-0008", "worktree");
  fs.writeFileSync(path.join(box.path, "feature.txt"), "done\n");
  git(box.path, "add", "-A");
  git(box.path, "commit", "-q", "-m", "feature");

  const refused = remove(root, "T-0008");
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /ahead/i);
  assert.equal(remove(root, "T-0008", { force: true }).removed, true);
});

test("a task id that could escape the boxes directory is rejected", () => {
  const root = repo();
  for (const bad of ["../evil", "a b", "", "T/0001", ".hidden", "T-0001;rm -rf /"]) {
    assert.throws(() => create(root, bad, "shared"), /Bad task id/, JSON.stringify(bad));
  }
  assert.throws(() => create(root, "T-0009", "nonsense"), /Unknown box mode/);
});

test("a sandbox is never deleted automatically: nothing in it is in git", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ak-home-"));
  process.env.AGENTKIT_HOME = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ak-plain-"));
  fs.writeFileSync(path.join(root, "src.txt"), "source");

  const box = create(root, "S-1", "sandbox");
  fs.writeFileSync(path.join(box.path, "AGENT-WORK.md"), "the only copy of this work");

  const refused = remove(root, "S-1");
  assert.equal(refused.removed, false, "a sandbox has no version control to recover from");
  assert.match(refused.reason, /recover|force/i);
  assert.ok(fs.existsSync(path.join(box.path, "AGENT-WORK.md")));

  const swept = gc(root, { keepDays: 0 });
  assert.deepEqual(swept.removed, [], "gc must not take it either");

  assert.equal(remove(root, "S-1", { force: true }).removed, true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTKIT_HOME;
});

test("two checkouts sharing a basename get separate boxes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ak-home-"));
  process.env.AGENTKIT_HOME = home;
  const parents = [];
  const mk = () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ak-team-"));
    parents.push(parent);
    const repo = path.join(parent, "api");
    fs.mkdirSync(repo);
    for (const a of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "x"]]) {
      execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
    }
    return repo;
  };
  const a = mk();
  const b = mk();
  assert.equal(path.basename(a), path.basename(b), "the whole point is a shared basename");
  const boxA = create(a, "T-1", "worktree");
  const boxB = create(b, "T-1", "worktree");
  assert.notEqual(boxA.path, boxB.path, "one team would be handed the other's uncommitted work");
  assert.equal(list(a).length, 1);
  assert.equal(list(b).length, 1);
  for (const d of [...parents, home]) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.AGENTKIT_HOME;
});

test("a box with unreadable metadata is reported, not raised", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ak-home-"));
  process.env.AGENTKIT_HOME = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ak-plain-"));
  create(root, "OK-1", "sandbox");
  const meta = path.join(boxesRoot(), repoName(root), ".meta", "BAD.json");
  fs.writeFileSync(meta, "{ broken");
  const rows = list(root);
  assert.equal(rows.length, 2, "the broken box must still be listed");
  const bad = rows.find((r) => r.taskId === "BAD");
  assert.ok(bad, "the only way to discover a broken box is the command that lists them");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTKIT_HOME;
});
