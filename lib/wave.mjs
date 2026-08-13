import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readDir, parseFront, write } from "./util.mjs";
import { DEFAULT_LIMITS } from "./resources.mjs";
import { run as runAgent } from "./orchestrator.mjs";
import { overlap } from "./team.mjs";

/**
 * Волна: очередь задач, которая идёт сама.
 *
 * Каждая задача проходит полный цикл — исполнитель, критик, для рискованных ещё
 * и аудитор безопасности, затем слияние в основную ветку и проверка, что она
 * осталась зелёной. Человек нужен там, где машина честно не может: конфликт
 * замысла, трижды не сошедшееся ревью, красная основная ветка после слияния.
 *
 * Всё остальное — работа запускателя, а не человека, который его запустил.
 */

const git = (root, args) => {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

const tasksDir = (root) => path.join(root, "tasks", "tasks");

function load(root) {
  return readDir(tasksDir(root))
    .map((f) => {
      const file = path.join(tasksDir(root), f);
      const { data, body } = parseFront(fs.readFileSync(file, "utf8"));
      return { file, data, body };
    })
    .filter((t) => t.data.id)
    .sort((a, b) => (a.data.id > b.data.id ? 1 : -1));
}

function setStatus(file, status, note) {
  let s = fs.readFileSync(file, "utf8");
  s = s.replace(/^status:.*$/m, `status: ${status}`);
  if (note) s = s.replace(/^---\n([\s\S]*?)\n---\n/, (m) => `${m}\n> ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${note}\n`);
  write(file, s);
}

const deps = (t) => String(t.data.blocked_by ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Ветка задачи целиком в основной: коммитов сверх нет и рабочая копия чиста. */
export function merged(root, id) {
  const branch = `ak/${id}`;
  if (!git(root, ["rev-parse", "--verify", branch]).ok) return false;
  if (git(root, ["rev-list", "--count", `HEAD..${branch}`]).out !== "0") return false;
  const wt = git(root, ["worktree", "list", "--porcelain"]).out
    .split(/\n\n+/)
    .map((b) => ({ p: (b.match(/^worktree (.+)$/m) || [])[1], br: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] }))
    .find((x) => x.br === branch);
  return !(wt?.p && git(wt.p, ["status", "--porcelain"]).out);
}

/**
 * Готова та задача, чьи зависимости влиты. «Принято критиком» не годится:
 * бокс отводится от основной ветки, и работы непринятой зависимости в нём нет —
 * исполнитель будет писать поверх несуществующего.
 */
export function ready(root, all) {
  const done = new Set(all.filter((t) => t.data.status === "done" && merged(root, t.data.id)).map((t) => t.data.id));
  return all.filter((t) => t.data.status === "todo" && deps(t).every((d) => done.has(d)));
}

const LOCKFILES = [
  ["pnpm-lock.yaml", ["pnpm", ["install", "--lockfile-only", "--ignore-scripts"]]],
  ["package-lock.json", ["npm", ["install", "--package-lock-only", "--ignore-scripts"]]],
];

/**
 * Слияние ветки задачи.
 *
 * Три вида конфликта и три разных ответа. История задачи дописана с двух сторон —
 * объединяем, кода там нет. Лок-файл — производная от манифестов, пересобираем.
 * Всё остальное — конфликт замысла: откатываем и зовём человека или интегратора,
 * потому что «свести» такое значит спрятать отсутствующее решение.
 */
export function mergeBranch(root, id, title) {
  const branch = `ak/${id}`;
  const wt = git(root, ["worktree", "list", "--porcelain"]).out
    .split(/\n\n+/)
    .map((b) => ({ p: (b.match(/^worktree (.+)$/m) || [])[1], br: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] }))
    .find((x) => x.br === branch);

  if (wt?.p && git(wt.p, ["status", "--porcelain"]).out) {
    git(wt.p, ["add", "-A"]);
    const c = git(wt.p, ["commit", "-m", `${title}\n\nЗадача ${id}.`]);
    if (!c.ok) return { ok: false, why: `коммит в ветке не прошёл: ${c.out.slice(0, 160)}` };
  }
  if (!git(root, ["rev-parse", "--verify", branch]).ok) return { ok: false, why: `ветки ${branch} нет` };
  if (git(root, ["merge-base", "--is-ancestor", branch, "HEAD"]).ok && git(root, ["rev-list", "--count", `HEAD..${branch}`]).out === "0") {
    return { ok: true, already: true };
  }

  // Бухгалтерия волны в основной ветке — наша же; фиксируем, иначе git не сольёт.
  if (git(root, ["status", "--porcelain"]).out) {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "Статусы задач и журнал запусков"]);
  }

  const m = git(root, ["merge", "--no-ff", "-m", `Влита задача ${id}: ${title}`, branch]);
  if (m.ok) return { ok: true };

  const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
  if (!conflicted.length) {
    git(root, ["merge", "--abort"]);
    return { ok: false, why: `git отказался сливать: ${m.out.replace(/\s+/g, " ").slice(0, 200)}` };
  }

  const lock = LOCKFILES.find(([f]) => conflicted.includes(f));
  const rest = conflicted.filter((f) => !f.startsWith("tasks/") && f !== lock?.[0]);
  if (rest.length) {
    git(root, ["merge", "--abort"]);
    return { ok: false, why: `конфликт замысла в ${rest.join(", ").slice(0, 160)}`, needsIntegrator: true, files: rest };
  }

  for (const f of conflicted.filter((x) => x.startsWith("tasks/"))) {
    const full = path.join(root, f);
    let text = fs.readFileSync(full, "utf8");
    text = text.replace(
      /<<<<<<< [^\n]*\n([\s\S]*?)(?:\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?)?=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g,
      (_, ours, theirs) =>
        /^status:/m.test(ours) && /^status:/m.test(theirs)
          ? "status: done\n"
          : [theirs, ours].map((x) => x.replace(/^\n+|\n+$/g, "")).filter(Boolean).join("\n") + "\n"
    );
    if (text.includes("<<<<<<<")) {
      git(root, ["merge", "--abort"]);
      return { ok: false, why: `историю задачи в ${f} объединить не удалось` };
    }
    write(full, text);
    git(root, ["add", f]);
  }

  if (lock) {
    git(root, ["checkout", "--theirs", lock[0]]);
    const r = spawnSync(lock[1][0], lock[1][1], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) {
      git(root, ["merge", "--abort"]);
      return { ok: false, why: `лок-файл не пересобрался: ${(r.stderr || "").replace(/\s+/g, " ").slice(0, 160)}` };
    }
    git(root, ["add", lock[0]]);
  }

  const c = git(root, ["commit", "--no-edit"]);
  if (!c.ok) {
    git(root, ["merge", "--abort"]);
    return { ok: false, why: `коммит слияния не прошёл: ${c.out.slice(0, 160)}` };
  }
  return { ok: true, unioned: true };
}

/**
 * Основная ветка после слияния обязана остаться зелёной.
 * Красная основная ветка блокирует всех, поэтому слияние откатывается сразу,
 * а не оставляется «на потом»: разбирать одно слияние дешевле, чем десять.
 */
export function verify(root, commands) {
  for (const cmd of commands) {
    const [bin, ...args] = cmd.split(/\s+/);
    const r = spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 15 * 60_000 });
    if (r.status !== 0) {
      return { ok: false, cmd, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").slice(-12).join("\n") };
    }
  }
  return { ok: true };
}

const VERDICT = (word) =>
  `Заверши отчёт отдельной последней строкой ровно в таком виде: ВЕРДИКТ: ${word} — либо — ВЕРДИКТ: доработать. Без неё отчёт не принимается.`;

const accepted = (text) => /ВЕРДИКТ:\s*принять/i.test(String(text || ""));

/** Одна задача целиком: исполнитель, ревью, для рискованных аудит, слияние, проверка. */
export async function carry(root, cfg, t, opts = {}) {
  const id = t.data.id;
  const { log = () => {}, attempts = new Map(), maxAttempts = 3, verifyCmds = [] } = opts;
  const done = (result, extra = {}) => ({ id, result, ...extra });

  log(`▶ ${id} · ${t.data.owner || "backend-dev"} · ${t.data.title || ""}`);
  setStatus(t.file, "in_progress", "взята волной");

  const impl = await runAgent(root, cfg, { task: id, priority: opts.priority, wait: true });
  if (impl.status === "deferred") {
    setStatus(t.file, "todo");
    return done("отложена", { deferred: true, why: impl.reason });
  }
  if (impl.status !== "done") {
    setStatus(t.file, "todo", `волна вернула в очередь: ${String(impl.reason || impl.status).slice(0, 120)}`);
    return done(`исполнитель: ${impl.status}`);
  }

  const rev = await runAgent(root, cfg, { task: id, role: "critic", instruction: VERDICT("принять"), wait: true });
  if (rev.status !== "done") {
    setStatus(t.file, "review", "исполнитель закончил, критик не отработал — нужен человек");
    return done("критик не отработал");
  }
  if (!accepted(rev.summary)) {
    const last = (attempts.get(id) || 0) + 1 >= maxAttempts;
    setStatus(t.file, last ? "review" : "todo", last ? "критик возражает после трёх заходов — дальше человек" : "критик вернул на доработку");
    log(`↩ ${id} доработать${last ? " (третий заход — человеку)" : ""}`);
    return done(last ? "трижды на доработку, ждёт человека" : "на доработку");
  }

  if (t.data.risk === "high") {
    const aud = await runAgent(root, cfg, {
      task: id,
      role: "security-auditor",
      wait: true,
      instruction:
        "Задача помечена risk: high и принята критиком. Твоя задача другая: утечка данных между арендаторами, превышение прав, " +
        "секреты в репозитории, обход RLS, необратимые миграции. Не повторяй работу критика. " + VERDICT("принять"),
    });
    if (aud.status !== "done") {
      setStatus(t.file, "review", "критик принял, аудитор не отработал — нужен человек");
      return done("аудитор не отработал");
    }
    if (!accepted(aud.summary)) {
      const last = (attempts.get(id) || 0) + 1 >= maxAttempts;
      setStatus(t.file, last ? "review" : "todo", last ? "аудитор возражает после трёх заходов — дальше человек" : "аудитор вернул на доработку");
      log(`↩ ${id} аудитор возражает`);
      return done(last ? "аудитор возражает, ждёт человека" : "аудитор вернул на доработку");
    }
  }

  const m = mergeBranch(root, id, t.data.title || id);
  if (!m.ok) {
    setStatus(t.file, "review", `слияние не прошло: ${m.why}`);
    log(`⚠ ${id} не влито: ${m.why.slice(0, 90)}`);
    return done(`слияние не прошло: ${m.why.slice(0, 60)}`, { needsIntegrator: m.needsIntegrator });
  }

  if (verifyCmds.length) {
    const v = verify(root, verifyCmds);
    if (!v.ok) {
      git(root, ["revert", "--no-edit", "-m", "1", "HEAD"]);
      setStatus(t.file, "todo", `слияние откачено: после него упало «${v.cmd}»`);
      log(`⚠ ${id} влито и откачено: упало ${v.cmd}`);
      return done(`после слияния упало ${v.cmd}`);
    }
  }

  setStatus(t.file, "done", m.already ? "уже было в основной ветке" : "принято и влито");
  log(`✓✓ ${id} влито`);
  return done("влито");
}
