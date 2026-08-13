import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { write } from "./util.mjs";

/**
 * Several logins of the same vendor, kept apart by whatever actually separates
 * them — which differs by vendor and was measured, not assumed:
 *
 *   claude-code  CLAUDE_CONFIG_DIR   an empty dir reports loggedIn:false
 *   cursor       HOME                an empty CURSOR_CONFIG_DIR still reports the
 *                                    same user; the token is in the macOS
 *                                    keychain, which is found through HOME
 *
 * Never by API key: a key is the metered path and is billed separately.
 */

export const homeDir = () => process.env.AGENTKIT_HOME || path.join(os.homedir(), ".agentkit");
export const accountDir = (id) => path.join(homeDir(), "accounts", String(id).replace(/[^A-Za-z0-9._-]/g, "-"));

const stateFile = (root) => path.join(root, ".agentkit", "state", "accounts.json");

export function readState(root) {
  const f = stateFile(root);
  if (!fs.existsSync(f)) return {};
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

function saveState(root, state) {
  write(stateFile(root), JSON.stringify(state, null, 2) + "\n");
}

/** Subscription windows roll; so does the load we count against them. */
export const WINDOW_MS = 5 * 60 * 60 * 1000;

function windowTokens(rec, now) {
  const runs = (rec?.runs || []).filter((r) => now - r.at < WINDOW_MS);
  return runs.reduce((n, r) => n + (r.tokens || 0), 0);
}

/**
 * Which login to run this on.
 *
 * Load is spread by tokens already spent in the current window rather than
 * round-robin: one task can cost ten times another, and alternating would let a
 * single account absorb every expensive one. Ties go to the least recently used.
 *
 * @returns {{id, provider, configDir, home}|null} null means "the CLI's own default login"
 */
export function pick(root, provider, probeResult, now = Date.now()) {
  const all = (probeResult?.accounts || []).filter((a) => a.provider === provider);
  if (!all.length) return null;

  const state = readState(root);
  const usable = all.filter((a) => {
    if (a.state !== "ready") return false;
    if (a.duplicateOf) return false; // the same login under another name
    const until = state[a.id]?.cooldownUntil || 0;
    return until <= now;
  });
  if (!usable.length) return null;

  const scored = usable.map((a) => ({
    account: a,
    tokens: windowTokens(state[a.id], now),
    last: state[a.id]?.lastUsedAt || 0,
  }));
  scored.sort((x, y) => x.tokens - y.tokens || x.last - y.last);
  const { id, provider: p, configDir, home } = scored[0].account;
  return { id, provider: p, configDir: configDir ?? null, home: home ?? null };
}

/** Record what a run cost an account, keeping only the current window. */
export function markUsed(root, accountId, { tokens = 0, status = "done", now = Date.now() } = {}) {
  if (!accountId) return;
  const state = readState(root);
  const rec = (state[accountId] ||= { runs: [] });
  rec.runs = (rec.runs || []).filter((r) => now - r.at < WINDOW_MS);
  rec.runs.push({ at: now, tokens, status });
  rec.lastUsedAt = now;
  saveState(root, state);
}

/**
 * Take an account out of rotation for a while. Used when a run comes back
 * rate-limited or unauthenticated: retrying the same login would fail the same way.
 */
export function cooldown(root, accountId, ms, reason, now = Date.now()) {
  if (!accountId) return;
  const state = readState(root);
  const rec = (state[accountId] ||= { runs: [] });
  rec.cooldownUntil = now + ms;
  rec.cooldownReason = reason || null;
  saveState(root, state);
}

/** Signals in a finished run that mean "this login, not this task, is the problem". */
const AUTH_TROUBLE = /rate.?limit|quota|usage limit|too many requests|unauthenticated|not logged in|401|429/i;

export function troubled(report) {
  const text = [report?.reason, report?.error, report?.summary].filter(Boolean).join(" ");
  if (report?.rateLimit && report.rateLimit.status && report.rateLimit.status !== "allowed") return "rate limit reached";
  return AUTH_TROUBLE.test(text) ? text.slice(0, 80) : null;
}

/** Per-account load for `agentkit providers`. */
export function summary(root, probeResult, now = Date.now()) {
  const state = readState(root);
  return (probeResult?.accounts || []).map((a) => ({
    id: a.id,
    provider: a.provider,
    state: a.state,
    email: a.detail?.email || null,
    tier: a.detail?.subscriptionType || a.detail?.tier || null,
    windowTokens: windowTokens(state[a.id], now),
    lastUsedAt: state[a.id]?.lastUsedAt || null,
    cooldownUntil: state[a.id]?.cooldownUntil || null,
    configDir: a.configDir || null,
    home: a.home || null,
    duplicateOf: a.duplicateOf || null,
    hint: a.hint || null,
  }));
}
