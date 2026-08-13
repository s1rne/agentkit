import fs from "node:fs";
import path from "node:path";
import * as claudeCode from "./claude-code.mjs";
import * as cursor from "./cursor-agent.mjs";
import * as codex from "./codex.mjs";

/** Order here is the tie-breaker when nothing else prefers one over another. */
export const PROVIDERS = [claudeCode, cursor, codex];

export function get(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // a read-only checkout is not a reason to fail a probe
  }
}

const fresh = (cached, ttlMs, accounts) => {
  if (!cached?.probedAt || !cached.providers) return false;
  const age = Date.now() - Date.parse(cached.probedAt);
  if (!(age >= 0 && age < ttlMs)) return false;
  const was = (cached.accounts || []).map((a) => a.id).sort().join(",");
  return was === accounts.map((a) => a.id).sort().join(",");
};

/**
 * Login state of every provider, plus every configured account
 * ({ id, provider, configDir }). Cached as JSON, re-probed when stale.
 * No model is ever called and nothing here throws.
 */
export async function probeAll({ accounts = [], ttlMs = 300000, cacheFile } = {}) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && a.provider) : [];
  if (cacheFile) {
    const cached = readJson(cacheFile);
    if (fresh(cached, ttlMs, list)) return cached;
  }

  const safe = async (p, configDir, home) => {
    try {
      return await p.probe({ configDir, home });
    } catch (e) {
      return { id: p.id, state: "absent", detail: { error: String(e?.message || e) }, hint: "the probe itself failed" };
    }
  };

  const probed = await Promise.all(PROVIDERS.map((p) => safe(p)));
  const providers = {};
  probed.forEach((r, i) => {
    providers[PROVIDERS[i].id] = {
      state: r.state,
      detail: r.detail ?? null,
      hint: r.hint ?? null,
      capabilities: PROVIDERS[i].capabilities,
    };
  });

  const accountResults = await Promise.all(
    list.map(async (a) => {
      const p = get(a.provider);
      if (!p) {
        return { ...a, state: "absent", detail: null, hint: `unknown provider: ${a.provider}` };
      }
      const r = await safe(p, a.configDir, a.home);
      return {
        id: a.id,
        provider: a.provider,
        configDir: a.configDir ?? null,
        home: a.home ?? null,
        state: r.state,
        detail: r.detail ?? null,
        hint: r.hint ?? null,
      };
    })
  );

  /**
   * Two entries resolving to the same identity are one login wearing two names:
   * spreading load across them buys nothing and hides that it bought nothing.
   */
  const byIdentity = new Map();
  for (const a of accountResults) {
    const key = `${a.provider}:${a.detail?.email || ""}`;
    if (!a.detail?.email) continue;
    if (byIdentity.has(key)) {
      const first = byIdentity.get(key);
      a.duplicateOf = first.id;
      a.hint = `same login as "${first.id}" (${a.detail.email}) — isolation did not take effect`;
    } else byIdentity.set(key, a);
  }

  const out = { probedAt: new Date().toISOString(), providers, accounts: accountResults };
  if (cacheFile) writeJson(cacheFile, out);
  return out;
}

/** Accepts a probeAll result, a plain { id: entry } map, or an array of probes. */
function normalize(probes) {
  const table = {};
  const src = probes?.providers ?? probes;
  if (Array.isArray(src)) {
    for (const e of src) if (e?.id) table[e.id] = e;
  } else if (src && typeof src === "object") {
    for (const [id, e] of Object.entries(src)) if (e && typeof e === "object") table[id] = { id, ...e };
  }
  return table;
}

const capsOf = (id, entry) => entry?.capabilities ?? get(id)?.capabilities ?? [];

/** cfg.prefer maps a capability to an ordered list of provider ids. */
function rankOf(id, want, cfg) {
  const prefer = cfg.prefer || {};
  for (const need of want) {
    const list = prefer[need];
    if (!Array.isArray(list)) continue;
    const i = list.indexOf(id);
    if (i >= 0) return i;
  }
  const base = PROVIDERS.findIndex((p) => p.id === id);
  return 100 + (base < 0 ? PROVIDERS.length : base);
}

const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Who could offer a capability, and what it would take to switch them on. */
function whoCould(cap, table) {
  const owners = PROVIDERS.filter((p) => p.capabilities.includes(cap));
  const parts = owners.map((p) => {
    const e = table[p.id];
    if (!e) return `${p.id} was not probed`;
    return e.state === "ready" ? `${p.id} is ready` : `${p.id} is ${e.state}${e.hint ? ` (${e.hint})` : ""}`;
  });
  return parts.length ? list(parts) : "no known provider offers it";
}

const empty = (reason) => ({ provider: null, model: null, degraded: true, reason, alternatives: [] });

/**
 * Pick a provider for a task. Only 'ready' ones are eligible — a 'metered'
 * login is never selected, because selecting it would spend money silently.
 * Never throws; a null provider is the caller's cue to block the task.
 */
export function route(needs = [], probes = {}, cfg = {}) {
  const want = [...new Set((Array.isArray(needs) ? needs : [needs]).filter(Boolean))];
  const table = normalize(probes);
  const entries = Object.entries(table);
  const ready = entries.filter(([, e]) => e.state === "ready");

  if (ready.length === 0) {
    const metered = entries.filter(([, e]) => e.state === "metered").map(([id]) => id);
    const why = entries.map(([id, e]) => `${id} — ${e.state}${e.hint ? ` (${e.hint})` : ""}`).join("; ");
    return empty(
      `no provider is ready${metered.length ? `; ${list(metered)} would bill per token and is never selected automatically` : ""}${why ? `. ${why}` : ""}`
    );
  }

  const scored = ready
    .map(([id, e]) => {
      const caps = capsOf(id, e);
      const missing = want.filter((n) => !caps.includes(n));
      return { id, missing, covers: want.length - missing.length, rank: rankOf(id, want, cfg) };
    })
    .sort((a, b) => b.covers - a.covers || a.rank - b.rank);

  const modelFor = (id) => cfg.models?.[id] ?? cfg.model ?? null;
  const full = scored.filter((s) => s.missing.length === 0);

  if (full.length) {
    const pick = full[0];
    return {
      provider: pick.id,
      model: modelFor(pick.id),
      degraded: false,
      reason: "",
      alternatives: scored.filter((s) => s.id !== pick.id).map((s) => s.id),
    };
  }

  // Nothing covers everything. Keep the essentials, name what is lost.
  const essential = Array.isArray(cfg.essential) ? cfg.essential : want.filter((n) => n === "code");
  const viable = scored.filter((s) => essential.every((n) => !s.missing.includes(n)));
  if (viable.length === 0) {
    return empty(
      `no ready provider covers ${list(essential)}: ${essential.map((n) => whoCould(n, table)).join("; ")}`
    );
  }

  const pick = viable[0];
  return {
    provider: pick.id,
    model: modelFor(pick.id),
    degraded: true,
    reason: `${pick.id} cannot do ${list(pick.missing)} — ${pick.missing.map((n) => whoCould(n, table)).join("; ")}`,
    alternatives: scored.filter((s) => s.id !== pick.id).map((s) => s.id),
  };
}

const STATE_TEXT = {
  ready: "ready",
  "not-logged-in": "not logged in",
  absent: "not installed",
  metered: "METERED — would bill per token, never selected",
};

/** Short human report for .agentkit/state/PROVIDERS.md. */
export function summary(probeResult) {
  const table = normalize(probeResult);
  const rows = PROVIDERS.map((p) => {
    const e = table[p.id] || { state: "absent", hint: "not probed" };
    const who = e.detail?.subscriptionType ? ` (${e.detail.subscriptionType})` : "";
    return `| ${p.id} | ${STATE_TEXT[e.state] || e.state}${who} | ${p.capabilities.join(", ")} | ${e.state === "ready" ? "—" : e.hint || "—"} |`;
  });

  const accounts = (probeResult?.accounts || []).map(
    (a) => `- ${a.id} → ${a.provider}: ${STATE_TEXT[a.state] || a.state}${a.configDir ? ` (${a.configDir})` : ""}`
  );

  return [
    `# Providers`,
    ``,
    `Probed at ${probeResult?.probedAt || "unknown"}. Agents run only through subscription CLIs — no API keys, no metered endpoints.`,
    ``,
    `| provider | state | what it adds | to enable |`,
    `| --- | --- | --- | --- |`,
    ...rows,
    ...(accounts.length ? [``, `## Accounts`, ``, ...accounts] : []),
    ``,
    `The core works on claude-code alone; every other provider is extra capability, never a requirement.`,
    ``,
  ].join("\n");
}
