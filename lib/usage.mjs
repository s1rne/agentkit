import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Token accounting read from the provider's own local transcripts.
 * Nothing here calls a network API: the numbers come from files the CLI already wrote.
 */

// Context window per model family. Unknown models fall back to the smallest, so a
// wrong guess makes us rotate the session early rather than blow past the window.
const WINDOWS = [
  [/opus-5|opus-4-[6789]|sonnet-5|sonnet-4-6|fable-5|mythos-5/, 1_000_000],
  [/opus-4|sonnet-4|haiku/, 200_000],
];
const FALLBACK_WINDOW = 200_000;

export function contextWindow(model = "") {
  for (const [re, size] of WINDOWS) if (re.test(model)) return size;
  return FALLBACK_WINDOW;
}

/**
 * Claude Code keeps one JSONL per session under a slug of the project path.
 * The exact slug rule is the CLI's, not ours, so the computed name is only a
 * first guess: if it is not there, find the directory instead of reporting
 * "no data" for a path containing a character we did not predict.
 */
export function transcriptDir(projectRoot) {
  const base = path.join(os.homedir(), ".claude", "projects");
  const guess = path.join(base, projectRoot.replace(/[/.]/g, "-"));
  if (fs.existsSync(guess)) return guess;
  const wanted = path.resolve(projectRoot).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  if (!fs.existsSync(base)) return guess;
  try {
    for (const d of fs.readdirSync(base)) {
      if (d.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() === wanted) {
        return path.join(base, d);
      }
    }
  } catch {}
  return guess;
}

export function transcripts(projectRoot) {
  const dir = transcriptDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { file: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * One line per content block, all carrying the same message id and the same
 * usage object. Counting every line inflates the total — measured at 2.7x on a
 * real transcript — so a request is counted once.
 */
function* usageRecords(file) {
  const seen = new Set();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    // "<synthetic>" marks messages the CLI fabricated locally — no request was made.
    if (m && m.model !== "<synthetic>" && m.usage && typeof m.usage.input_tokens === "number") {
      if (m.id) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
      }
      yield { usage: m.usage, model: m.model, ts: d.timestamp };
    }
  }
}

/**
 * How full a session's context is right now.
 * The last request's input + cache is exactly what the model had to read.
 */
export function sessionContext(file) {
  let last = null;
  let model = "";
  for (const r of usageRecords(file)) {
    last = r.usage;
    model = r.model || model;
  }
  if (!last) return null;
  const tokens =
    (last.input_tokens || 0) +
    (last.cache_read_input_tokens || 0) +
    (last.cache_creation_input_tokens || 0);
  const window = contextWindow(model);
  return { tokens, window, pct: Math.round((tokens / window) * 1000) / 10, model, file };
}

/** Newest session for a project — the one a human would call "the current one". */
export function currentContext(projectRoot) {
  const [newest] = transcripts(projectRoot);
  return newest ? sessionContext(newest.file) : null;
}

/**
 * Total tokens spent since `since` (epoch ms), across every project.
 * Cache reads are counted separately: they are the bulk of the volume and the
 * cheapest part of it, so mixing them into one number hides what actually costs.
 */
export function spentSince(since) {
  const base = path.join(os.homedir(), ".claude", "projects");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 };
  const byModel = {};
  if (!fs.existsSync(base)) return { since, totals, byModel };

  for (const proj of fs.readdirSync(base)) {
    const dir = path.join(base, proj);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < since) continue;
      } catch {
        continue;
      }
      for (const r of usageRecords(p)) {
        const t = r.ts ? Date.parse(r.ts) : NaN;
        if (Number.isFinite(t) && t < since) continue;
        const u = r.usage;
        totals.input += u.input_tokens || 0;
        totals.output += u.output_tokens || 0;
        totals.cacheRead += u.cache_read_input_tokens || 0;
        totals.cacheCreate += u.cache_creation_input_tokens || 0;
        totals.requests++;
        const m = (byModel[r.model || "unknown"] ||= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
        m.input += u.input_tokens || 0;
        m.output += u.output_tokens || 0;
        m.cacheRead += u.cache_read_input_tokens || 0;
        m.cacheCreate += u.cache_creation_input_tokens || 0;
      }
    }
  }
  return { since, totals, byModel };
}

/** Claude subscription limits reset on a rolling five-hour window. */
export const WINDOW_MS = 5 * 60 * 60 * 1000;

export function windowUsage(now = Date.now()) {
  return spentSince(now - WINDOW_MS);
}

export function today(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return spentSince(d.getTime());
}

export const fmt = (n) => n.toLocaleString("en-US");
