import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readDir, parseFront, write } from "./util.mjs";
import { DEFAULT_LIMITS } from "./resources.mjs";
import { run as runAgent } from "./orchestrator.mjs";
import { overlap } from "./team.mjs";
import * as boxes from "./boxes.mjs";

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
  /**
   * Ветки нет — значит задача делалась в самом рабочем каталоге, и её работа
   * уже там, где ей место. Сливать нечего, и «не влита» для такой задачи
   * означало бы «не влита никогда»: обычная задача одного исполнителя ветки не
   * заводит, а зависящие от неё ждали бы её вечно.
   */
  if (!git(root, ["rev-parse", "--verify", branch]).ok) return true;
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
 * Работа задачи, сделанная без ветки, — то есть прямо в рабочем каталоге.
 *
 * Обычная задача одного исполнителя получает общий бокс: агент пишет в рабочий
 * каталог, ветки не заводится. Требовать от неё слияния значит не дать ей
 * закончиться никогда. Здесь работа просто фиксируется там, где она сделана.
 *
 * Песочница — другое дело: её содержимое лежит вне репозитория, и перенести
 * его обратно правилом нельзя.
 */
function commitInPlace(root, id, title, mode) {
  if (mode === "sandbox") {
    return {
      ok: false,
      why: `работа задачи ${id} лежит в песочнице вне репозитория — перенести её может только человек`,
      needsIntegrator: true,
    };
  }
  if (!git(root, ["status", "--porcelain"]).out) return { ok: true, inPlace: true, nothing: true };
  git(root, ["add", "-A"]);
  const c = git(root, ["commit", "-m", `${title}\n\nЗадача ${id}.`]);
  if (!c.ok) return { ok: false, why: `коммит в рабочем каталоге не прошёл: ${c.out.slice(0, 160)}` };
  return { ok: true, inPlace: true };
}

/**
 * Слияние ветки задачи.
 *
 * Три вида конфликта и три разных ответа. История задачи дописана с двух сторон —
 * объединяем, кода там нет. Лок-файл — производная от манифестов, пересобираем.
 * Всё остальное — конфликт замысла: откатываем и зовём человека или интегратора,
 * потому что «свести» такое значит спрятать отсутствующее решение.
 *
 * Ветки может не быть вовсе — тогда работа велась в рабочем каталоге, и слияние
 * сводится к её фиксации.
 */
export function mergeBranch(root, id, title, { mode = null } = {}) {
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
  if (!git(root, ["rev-parse", "--verify", branch]).ok) {
    return commitInPlace(root, id, title, mode ?? boxes.describe(root, id)?.mode ?? null);
  }
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

/**
 * Отменить то, что мы только что добавили в основную ветку, и ничего сверх.
 *
 * Слияние — это коммит с двумя родителями, обычная фиксация в рабочем каталоге —
 * с одним, и `-m 1` для второго случая git просто не примет. А задача, работа
 * которой уже была в основной ветке, не добавила ничего: откат HEAD снёс бы
 * чужой коммит.
 */
function revert(root, before) {
  const head = git(root, ["rev-parse", "HEAD"]).out;
  if (!before || !head || head === before) return false;
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).out.trim().split(/\s+/).length - 1;
  return git(root, ["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), "HEAD"]).ok;
}

const VERDICT = (word) =>
  `Заверши отчёт отдельной последней строкой ровно в таком виде: ВЕРДИКТ: ${word} — либо — ВЕРДИКТ: доработать. Без неё отчёт не принимается.`;

const accepted = (text) => /ВЕРДИКТ:\s*принять/i.test(String(text || ""));

/**
 * Подтянуть основную ветку в копию задачи перед работой.
 *
 * Копия создаётся один раз и дальше живёт своей жизнью. На живом прогоне ветки
 * отстали на шестьдесят с лишним коммитов: исполнитель писал под контракт,
 * который в основной ветке уже сменили, слияние проходило, а тесты падали — и
 * так три раза подряд. Работать в копии, не видящей проект, бессмысленно.
 *
 * Конфликт при подтягивании — это столкновение с чужой работой, и разрешать его
 * должен тот, кто задачу делает, а не слияние задним числом.
 */
export function refresh(root, id, base = "main") {
  const branch = `ak/${id}`;
  const wt = git(root, ["worktree", "list", "--porcelain"]).out
    .split(/\n\n+/)
    .map((b) => ({ p: (b.match(/^worktree (.+)$/m) || [])[1], br: (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] }))
    .find((x) => x.br === branch);
  if (!wt?.p) return { ok: true, skipped: "копии нет" };

  const behind = git(root, ["rev-list", "--count", `${branch}..${base}`]).out;
  if (behind === "0") return { ok: true, behind: 0 };

  if (git(wt.p, ["status", "--porcelain"]).out) {
    git(wt.p, ["add", "-A"]);
    git(wt.p, ["commit", "-m", `Промежуточная работа по задаче ${id}`]);
  }
  const m = git(wt.p, ["merge", "--no-edit", base]);
  if (!m.ok) {
    git(wt.p, ["merge", "--abort"]);
    return { ok: false, behind: Number(behind), why: `копия отстала на ${behind} коммитов и не сливается с ${base}` };
  }
  return { ok: true, behind: Number(behind), refreshed: true };
}

/**
 * Поток событий волны.
 *
 * Наружу раньше отдавался только итог, а итог бесполезен тому, кто показывает
 * человеку происходящее сейчас: задача полчаса в работе — и непонятно,
 * исполнитель ещё пишет, критик уже смотрит или всё повисло. Считать это
 * опросом файлов задач нельзя: такой счёт отстаёт и не видит середины.
 *
 * Схема одна и та же у всех событий: время, задача, стадия, что случилось.
 * Стадии — impl, critic, audit, refresh, merge, verify; события — started,
 * finished, verdict, deferred, conflict, reverted.
 */
export function eventLog(root, { file = null, at = new Date() } = {}) {
  const f = file || path.join(root, ".agentkit", "state", "runs", `wave-${at.toISOString().replace(/[:.]/g, "-")}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return {
    file: f,
    onEvent(e) {
      // Журнал наблюдателя не имеет права уронить работу, ради которой он ведётся.
      try {
        fs.appendFileSync(f, JSON.stringify(e) + "\n", "utf8");
      } catch {
        /* полный диск — не повод бросать задачу */
      }
    },
  };
}

/** Что известно о прогоне агента и стоит знать наблюдателю. */
const runFacts = (r) => ({
  ok: r.status === "done",
  status: r.status,
  provider: r.provider || null,
  account: r.account || null,
  tokens: r.usage?.total ?? null,
  durationMs: r.durationMs ?? null,
  ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}),
});

/** Одна задача целиком: исполнитель, ревью, для рискованных аудит, слияние, проверка. */
export async function carry(root, cfg, t, opts = {}) {
  const id = t.data.id;
  const { log = () => {}, attempts = new Map(), maxAttempts = 3, verifyCmds = [], onEvent = null } = opts;
  const done = (result, extra = {}) => ({ id, result, ...extra });
  const attempt = (attempts.get(id) || 0) + 1;
  const emit = (stage, event, fields = {}) => {
    if (!onEvent) return;
    try {
      onEvent({ at: new Date().toISOString(), task: id, stage, event, ...fields });
    } catch {
      /* наблюдатель, который падает, остаётся своей проблемой */
    }
  };

  log(`▶ ${id} · ${t.data.owner || "backend-dev"} · ${t.data.title || ""}`);
  setStatus(t.file, "in_progress", "взята волной");

  const fresh = refresh(root, id, opts.base || "main");
  if (!fresh.ok) {
    setStatus(t.file, "review", fresh.why);
    log(`⚠ ${id} ${fresh.why}`);
    emit("refresh", "conflict", { why: fresh.why, behind: fresh.behind ?? null, needsIntegrator: true });
    return done(fresh.why, { needsIntegrator: true });
  }
  if (fresh.refreshed) {
    log(`  ${id} копия догнала основную ветку (+${fresh.behind})`);
    emit("refresh", "finished", { ok: true, behind: fresh.behind });
  }

  emit("impl", "started", { role: t.data.owner || "backend-dev", attempt });
  const impl = await runAgent(root, cfg, { task: id, priority: opts.priority, wait: true });
  if (impl.status === "deferred") {
    setStatus(t.file, "todo");
    emit("impl", "deferred", { reason: impl.reason || null });
    return done("отложена", { deferred: true, why: impl.reason });
  }
  emit("impl", "finished", runFacts(impl));
  if (impl.status !== "done") {
    setStatus(t.file, "todo", `волна вернула в очередь: ${String(impl.reason || impl.status).slice(0, 120)}`);
    return done(`исполнитель: ${impl.status}`);
  }

  emit("critic", "started", { role: "critic", attempt });
  const rev = await runAgent(root, cfg, { task: id, role: "critic", instruction: VERDICT("принять"), wait: true });
  emit("critic", "finished", runFacts(rev));
  if (rev.status !== "done") {
    setStatus(t.file, "review", "исполнитель закончил, критик не отработал — нужен человек");
    return done("критик не отработал");
  }
  if (!accepted(rev.summary)) {
    const last = attempt >= maxAttempts;
    emit("critic", "verdict", { accepted: false, attempt, last });
    setStatus(t.file, last ? "review" : "todo", last ? "критик возражает после трёх заходов — дальше человек" : "критик вернул на доработку");
    log(`↩ ${id} доработать${last ? " (третий заход — человеку)" : ""}`);
    return done(last ? "трижды на доработку, ждёт человека" : "на доработку");
  }
  emit("critic", "verdict", { accepted: true, attempt });

  if (t.data.risk === "high") {
    emit("audit", "started", { role: "security-auditor", attempt });
    const aud = await runAgent(root, cfg, {
      task: id,
      role: "security-auditor",
      wait: true,
      instruction:
        "Задача помечена risk: high и принята критиком. Твоя задача другая: утечка данных между арендаторами, превышение прав, " +
        "секреты в репозитории, обход RLS, необратимые миграции. Не повторяй работу критика. " + VERDICT("принять"),
    });
    emit("audit", "finished", runFacts(aud));
    if (aud.status !== "done") {
      setStatus(t.file, "review", "критик принял, аудитор не отработал — нужен человек");
      return done("аудитор не отработал");
    }
    if (!accepted(aud.summary)) {
      const last = attempt >= maxAttempts;
      emit("audit", "verdict", { accepted: false, attempt, last });
      setStatus(t.file, last ? "review" : "todo", last ? "аудитор возражает после трёх заходов — дальше человек" : "аудитор вернул на доработку");
      log(`↩ ${id} аудитор возражает`);
      return done(last ? "аудитор возражает, ждёт человека" : "аудитор вернул на доработку");
    }
    emit("audit", "verdict", { accepted: true, attempt });
  }

  const before = git(root, ["rev-parse", "HEAD"]).out;
  emit("merge", "started", { mode: impl.box?.mode || null, branch: impl.box?.branch || null });
  const m = mergeBranch(root, id, t.data.title || id, { mode: impl.box?.mode });
  if (!m.ok) {
    emit("merge", "conflict", { why: m.why, files: m.files || [], needsIntegrator: Boolean(m.needsIntegrator) });
    setStatus(t.file, "review", `слияние не прошло: ${m.why}`);
    log(`⚠ ${id} не влито: ${m.why.slice(0, 90)}`);
    return done(`слияние не прошло: ${m.why.slice(0, 60)}`, { needsIntegrator: m.needsIntegrator });
  }
  emit("merge", "finished", { ok: true, inPlace: Boolean(m.inPlace), already: Boolean(m.already), unioned: Boolean(m.unioned) });

  if (verifyCmds.length) {
    emit("verify", "started", { commands: verifyCmds });
    const v = verify(root, verifyCmds);
    if (!v.ok) {
      // Откатывать можно только то, что мы сами и создали: задача, чья работа уже
      // была в основной ветке, ничего не добавила, и откат HEAD снёс бы чужое.
      const undone = revert(root, before);
      emit("verify", "finished", { ok: false, cmd: v.cmd });
      if (undone) emit("merge", "reverted", { cmd: v.cmd });
      setStatus(t.file, "todo", undone ? `слияние откачено: после него упало «${v.cmd}»` : `после слияния упало «${v.cmd}»`);
      log(`⚠ ${id} ${undone ? "влито и откачено" : "влито"}: упало ${v.cmd}`);
      return done(`после слияния упало ${v.cmd}`);
    }
    emit("verify", "finished", { ok: true });
  }

  const how = m.already ? "уже было в основной ветке" : m.inPlace ? "принято, работа в основной ветке" : "принято и влито";
  setStatus(t.file, "done", how);
  log(`✓✓ ${id} ${m.inPlace ? "готово" : "влито"}`);
  return done(m.inPlace ? "готово" : "влито");
}
