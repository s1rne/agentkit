import fs from "node:fs";
import path from "node:path";
import { readDir, parseFront } from "./util.mjs";
import { capacity, DEFAULT_LIMITS, maxConcurrency, processTreeRSS } from "./resources.mjs";
import { activeRuns } from "./orchestrator.mjs";
import { windowUsage, fmt } from "./usage.mjs";

/**
 * What the team is doing right now, gathered from what already exists on disk:
 * the active-run registry, finished run records, task frontmatter and the boxes.
 * Nothing here starts a process or calls a model — it is safe to poll.
 */

const runsDir = (root) => path.join(root, ".agentkit", "state", "runs");

/** Claude Code reports a running total in its stream; the last one is the current cost. */
function liveTokens(file) {
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    const fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    const from = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  let est = null;
  for (const line of text.split("\n")) {
    if (!line.includes("estimated_tokens")) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d.estimated_tokens === "number") est = d.estimated_tokens;
    } catch {}
  }
  return est;
}

function taskIndex(root) {
  const out = new Map();
  for (const sub of ["tasks", "features", "epics", "done"]) {
    const dir = path.join(root, "tasks", sub);
    for (const f of readDir(dir)) {
      const { data, body } = parseFront(fs.readFileSync(path.join(dir, f), "utf8"));
      if (data.id) out.set(data.id, { ...data, file: path.join("tasks", sub, f), body });
    }
  }
  return out;
}

const deps = (t) => String(t?.blocked_by ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Finished runs, newest first. */
export function history(root, limit = 8) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "active.json")
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return { ...r, at: fs.statSync(path.join(dir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function gather(root, cfg = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  const cap = capacity(root);
  const tasks = taskIndex(root);

  const active = activeRuns(root).map((r) => {
    const rss = processTreeRSS(r.pid);
    const t = tasks.get(r.task);
    return {
      ...r,
      title: t?.title || null,
      branch: t ? `ak/${r.task}` : null,
      elapsedMs: Date.now() - (r.startedAt || Date.now()),
      rssMB: rss,
      tokens: liveTokens(path.join(runsDir(root), `${r.runId}.jsonl`)),
    };
  });

  /**
   * Зависимость считается закрытой только по `done`, то есть по влитому.
   * `review` — это «критик принял», а не «следующий может начать»: бокс
   * отводится от основной ветки, и работа принятой, но не влитой задачи в нём
   * не видна. Показывать такую задачу готовой значит звать агента писать
   * поверх несуществующего.
   */
  const done = new Set([...tasks.values()].filter((t) => t.status === "done").map((t) => t.id));
  const all = [...tasks.values()].filter((t) => String(t.id).startsWith("T-"));
  const running = new Set(active.map((a) => a.task));

  return {
    active,
    capacity: cap,
    slots: maxConcurrency(limits, cap),
    window: windowUsage().totals,
    ready: all.filter((t) => t.status === "todo" && !running.has(t.id) && deps(t).every((d) => done.has(d))),
    waiting: all.filter((t) => t.status === "todo" && !deps(t).every((d) => done.has(d))),
    forHuman: all.filter((t) => t.status === "review"),
    merged: all.filter((t) => t.status === "done"),
    history: history(root),
    tasks,
  };
}

/** One agent in detail: what it is doing, where, and what the last review said. */
export function detail(root, key) {
  const g = gather(root);
  const live = g.active.find((a) => a.runId === key || a.task === key);
  const task = g.tasks.get(live?.task || key);
  const past = history(root, 200).filter((r) => r.task === (live?.task || key) || r.runId === key);
  const verdict = task?.body?.match(/### critic[^\n]*\n([\s\S]*?)(?=\n### |$)/g)?.at(-1) || null;
  return { live, task, past, verdict };
}
