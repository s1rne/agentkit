import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as claudeCode from "../lib/providers/claude-code.mjs";
import * as cursor from "../lib/providers/cursor-agent.mjs";
import * as codex from "../lib/providers/codex.mjs";
import { PROVIDERS, get, probeAll, route, summary } from "../lib/providers/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "claude-code.stream.jsonl"), "utf8");

// Stubs — routing must be decidable without shelling out to anything.
const READY = { state: "ready", detail: {}, hint: null, capabilities: claudeCode.capabilities };
const CURSOR_OFF = { state: "not-logged-in", detail: {}, hint: "run: cursor-agent login", capabilities: cursor.capabilities };
const CURSOR_READY = { ...CURSOR_OFF, state: "ready", hint: null };
const CODEX_OFF = { state: "absent", detail: {}, hint: "not supported yet", capabilities: codex.capabilities };
const onlyClaude = { "claude-code": READY, cursor: CURSOR_OFF, codex: CODEX_OFF };

test("the three providers expose the same shape", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude-code", "cursor", "codex"]);
  for (const p of PROVIDERS) {
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.bin, "string");
    assert.ok(Array.isArray(p.capabilities) && p.capabilities.length > 0);
    for (const fn of ["probe", "spawnSpec", "parseStream"]) assert.equal(typeof p[fn], "function", `${p.id}.${fn}`);
    assert.equal(get(p.id), p);
  }
  assert.equal(get("nope"), null);
  assert.equal(claudeCode.configDirEnv, "CLAUDE_CONFIG_DIR");
  assert.equal(cursor.configDirEnv, "CURSOR_CONFIG_DIR");
  assert.equal(codex.configDirEnv, null);
});

test("parseStream reads the real captured run", () => {
  const r = claudeCode.parseStream(fixture);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.text, "ok");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.turns, 1);
  assert.equal(r.durationMs, 2844);
  assert.equal(r.cost, 0.0212441);
  assert.equal(r.sessionId, "6507f99f-fc6a-4ea9-b1de-18eac66a9b10");

  assert.deepEqual(r.usage, { input: 10, output: 42, cacheRead: 16491, cacheCreate: 9405, total: 25948 });
  assert.equal(r.usage.total, r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheCreate);

  assert.equal(r.rateLimit.type, "five_hour");
  assert.equal(r.rateLimit.status, "allowed");
  assert.equal(r.rateLimit.isUsingOverage, false);
  assert.equal(r.rateLimit.resetsAt, new Date(1786618800 * 1000).toISOString());
  assert.match(r.rateLimit.resetsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("parseStream reports bad input instead of throwing", () => {
  for (const bad of ["", "   \n\n", "not json\n{", null, undefined]) {
    const r = claudeCode.parseStream(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 0);
    assert.equal(r.usage, null);
  }
  // a truncated run: real events, no result
  const cut = fixture.split("\n").filter((l) => !l.includes('"type":"result"')).join("\n");
  const r = claudeCode.parseStream(cut);
  assert.equal(r.ok, false);
  assert.match(r.error, /result/i);
  assert.equal(r.text, "ok", "the partial text is still handed back");
});

test("parseStream skips torn lines but keeps the good ones", () => {
  const r = claudeCode.parseStream(`{"type":"system"}\n<<garbage>>\n${fixture.trim().split("\n").pop()}`);
  assert.equal(r.ok, true);
  assert.equal(r.text, "ok");
});

test("cursor parseStream reads its real captured run", () => {
  const raw = fs.readFileSync(new URL("./fixtures/cursor.stream.jsonl", import.meta.url), "utf8");
  const r = cursor.parseStream(raw);
  assert.equal(r.ok, true);
  assert.equal(r.text, "ok");
  assert.equal(r.parserConfidence, "verified");
  // This CLI reports camelCase and shorter cache names than Claude Code does.
  assert.deepEqual(r.usage, { input: 20450, output: 32, cacheRead: 7049, cacheCreate: 0, total: 27531 });
  assert.equal(r.durationMs, 9427);
  // The init event states how the run authenticated; "login" means the subscription.
  assert.equal(r.apiKeySource, "login");
  assert.equal(r.metered, false);

  const metered = raw.replace('"apiKeySource":"login"', '"apiKeySource":"api_key"').replace('"apiKeySource": "login"', '"apiKeySource": "api_key"');
  assert.equal(cursor.parseStream(metered).metered, true, "a per-token run must be reported, even when it succeeds");

  const unknown = cursor.parseStream('{"type":"delta","text":"he"}\n{"type":"delta","text":"llo"}');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.text, "hello", "an unrecognised shape still yields its text");
  assert.equal(unknown.usage, null, "no usage is invented when none was reported");

  assert.equal(cursor.parseStream("").ok, false);
  assert.equal(cursor.parseStream("nope\n{").ok, false);
});

test("codex refuses to be spawned", () => {
  assert.throws(() => codex.spawnSpec({ prompt: "hi" }), /not written yet|not supported/i);
  assert.equal(codex.parseStream("{}").ok, false);
});

test("claude spawnSpec keeps --verbose and drops API keys", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-should-never-be-passed";
  process.env.CURSOR_API_KEY = "cur-test";
  try {
    const spec = claudeCode.spawnSpec({ prompt: "hi", model: "sonnet", cwd: "/tmp", configDir: "/tmp/cfg" });
    assert.equal(spec.cmd, "claude");
    assert.ok(spec.args.includes("--verbose"), "stream-json refuses to start without --verbose");
    assert.deepEqual(spec.args.slice(0, 5), ["-p", "hi", "--output-format", "stream-json", "--verbose"]);
    // Without an explicit permission mode a headless run stops at the first write.
    assert.deepEqual(spec.args.slice(5, 7), ["--permission-mode", "acceptEdits"]);
    assert.ok(spec.args.includes("sonnet"));

    const ro = claudeCode.spawnSpec({ prompt: "hi", permission: "read" });
    assert.ok(ro.args.includes("plan"), "a reading role gets the read-only permission mode");
    assert.ok(ro.args.includes("--disallowed-tools"));
    const iso = claudeCode.spawnSpec({ prompt: "hi", permission: "isolated" });
    assert.ok(iso.args.includes("bypassPermissions"), "prompts are only bypassed inside an isolated box");

    const cro = cursor.spawnSpec({ prompt: "hi", permission: "read" });
    assert.ok(!cro.args.includes("--force"), "--force would defeat plan mode");
    assert.deepEqual(cro.args.slice(-4), ["--mode", "plan", "--", "hi"]);
    // Cursor has nothing between plan and --force, so it must never write in the
    // human's own directory; the orchestrator relies on this flag to refuse.
    assert.equal(cursor.sharedWriteSafe, false);
    assert.equal(claudeCode.sharedWriteSafe, true);
    assert.equal(spec.cwd, "/tmp");
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!("ANTHROPIC_API_KEY" in spec.env), "the key must be removed, not blanked");
    assert.equal(spec.env.CLAUDE_CONFIG_DIR, "/tmp/cfg");

    const c = cursor.spawnSpec({ prompt: "hi", cwd: "/tmp", configDir: "/tmp/cur" });
    assert.equal(c.cmd, "cursor-agent");
    for (const flag of ["-p", "--force", "--trust", "--output-format", "stream-json"]) {
      assert.ok(c.args.includes(flag), `missing ${flag}`);
    }
    assert.equal(c.args[c.args.length - 1], "hi", "the prompt is a positional argument");
    assert.equal(c.args[c.args.length - 2], "--", "a prompt starting with - must not be read as a flag");
    assert.ok(!("CURSOR_API_KEY" in c.env));
    assert.equal(c.env.CURSOR_CONFIG_DIR, "/tmp/cur");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
  }
});

test("route picks the only ready provider", () => {
  const r = route(["code"], onlyClaude);
  assert.equal(r.provider, "claude-code");
  assert.equal(r.degraded, false);
  assert.deepEqual(r.alternatives, []);
});

test("route degrades instead of failing when a capability is missing", () => {
  const r = route(["images"], onlyClaude);
  assert.equal(r.provider, "claude-code", "a ready provider is still returned");
  assert.equal(r.degraded, true);
  assert.match(r.reason, /images/);
  assert.match(r.reason, /cursor/, "the reason names who could provide it");

  const both = route(["code", "images"], onlyClaude);
  assert.equal(both.provider, "claude-code");
  assert.equal(both.degraded, true);
  assert.match(both.reason, /images/);
});

test("route never returns a metered or otherwise non-ready provider", () => {
  const metered = {
    "claude-code": { ...READY, state: "metered", hint: "bills per token" },
    cursor: CURSOR_OFF,
    codex: CODEX_OFF,
  };
  const r = route(["code"], metered);
  assert.equal(r.provider, null);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /bill|meter/i);

  // metered must lose even when a ready provider covers less
  const mixed = { "claude-code": { ...READY, state: "metered" }, cursor: CURSOR_READY, codex: CODEX_OFF };
  assert.equal(route(["big-context"], mixed).provider, "cursor");

  for (const needs of [[], ["code"], ["images"], ["worktree", "plan-mode"], ["nonsense"]]) {
    for (const probes of [onlyClaude, metered, mixed, {}, { providers: onlyClaude }]) {
      const out = route(needs, probes);
      assert.ok(out.provider === null || probesState(probes, out.provider) === "ready", JSON.stringify(out));
      assert.equal(typeof out.reason, "string");
      assert.ok(Array.isArray(out.alternatives));
    }
  }
});

const probesState = (probes, id) => (probes.providers ?? probes)[id]?.state;

test("route honours cfg.prefer and survives junk input", () => {
  const bothReady = { "claude-code": READY, cursor: CURSOR_READY, codex: CODEX_OFF };
  assert.equal(route(["code"], bothReady).provider, "claude-code", "declaration order is the default");
  assert.equal(route(["code"], bothReady, { prefer: { code: ["cursor", "claude-code"] } }).provider, "cursor");
  assert.equal(route(["code"], bothReady).alternatives.includes("cursor"), true);

  assert.equal(route("code", bothReady).provider, "claude-code", "a bare string works too");
  assert.equal(route(["code"], null).provider, null);
  assert.equal(route(undefined, undefined).provider, null);
  assert.equal(route(["code"], [{ id: "cursor", ...CURSOR_READY }]).provider, "cursor", "array form");
  assert.equal(route(["code"], bothReady, { models: { "claude-code": "opus" } }).model, "opus");
});

test("probe of an absent binary says absent and how to fix it", async () => {
  const r = await codex.probe();
  assert.equal(r.state, "absent");
  assert.match(r.hint, /\S/);

  // hide every binary: the ENOENT path must degrade, not throw
  const realPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), "ak-empty-path-xyz");
  try {
    for (const p of [claudeCode, cursor]) {
      const miss = await p.probe();
      assert.equal(miss.state, "absent", p.id);
      assert.equal(miss.detail.installed, false);
      assert.match(miss.hint, /install/i);
    }
  } finally {
    process.env.PATH = realPath;
  }

  // an absent CLI must never throw out of probeAll either
  const all = await probeAll({ ttlMs: 0 });
  assert.equal(typeof all.probedAt, "string");
  for (const p of PROVIDERS) {
    const e = all.providers[p.id];
    assert.ok(["ready", "not-logged-in", "absent", "metered"].includes(e.state), `${p.id}: ${e.state}`);
    assert.deepEqual(e.capabilities, p.capabilities);
    if (e.state !== "ready") assert.equal(typeof e.hint, "string");
  }
});

test("probeAll caches and re-probes when stale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-prov-"));
  const cacheFile = path.join(dir, "state", ".providers-cache.json");
  const first = await probeAll({ cacheFile, ttlMs: 300000 });
  assert.ok(fs.existsSync(cacheFile), "the cache file is written");

  const second = await probeAll({ cacheFile, ttlMs: 300000 });
  assert.equal(second.probedAt, first.probedAt, "a fresh cache is reused");

  const third = await probeAll({ cacheFile, ttlMs: 0 });
  assert.notEqual(third.probedAt, undefined);

  // a corrupt cache is not a crash
  fs.writeFileSync(cacheFile, "{ broken", "utf8");
  const fourth = await probeAll({ cacheFile });
  assert.equal(typeof fourth.probedAt, "string");

  // an unknown provider in an account list is reported, not thrown
  const acc = await probeAll({ cacheFile, ttlMs: 0, accounts: [{ id: "second", provider: "nope" }] });
  assert.equal(acc.accounts[0].state, "absent");
  assert.match(acc.accounts[0].hint, /unknown provider/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("summary is a short report that ends on the claude-code-alone promise", () => {
  const text = summary({ probedAt: "2026-01-01T00:00:00.000Z", providers: onlyClaude, accounts: [] });
  for (const p of PROVIDERS) assert.ok(text.includes(p.id), p.id);
  assert.ok(text.includes("run: cursor-agent login"), "the exact enabling command is in there");
  assert.ok(text.trim().endsWith("The core works on claude-code alone; every other provider is extra capability, never a requirement."));
  assert.ok(text.length < 1600, `too long: ${text.length}`);
  assert.ok(summary({}).includes("claude-code alone"), "an empty probe result still renders");
});

test("cursor surfaces a rate limit even though it emits no event for it", () => {
  const hit = cursor.parseStream(
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Rate limit exceeded, try again later" })
  );
  assert.equal(hit.ok, false);
  // Claude Code has rate_limit_event; this CLI has only the wording, and without
  // reading it the account rotation would never take a spent login out.
  assert.equal(hit.rateLimit.status, "exceeded");

  const ordinary = cursor.parseStream(
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "file not found" })
  );
  assert.equal(ordinary.rateLimit, null, "an ordinary failure must not rest the account");
});
