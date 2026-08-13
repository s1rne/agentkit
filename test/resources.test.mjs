import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RISKY_ENV, riskyEnvPresent, safeEnv } from "../lib/env.mjs";
import { capacity, DEFAULT_LIMITS, maxConcurrency, admits, processTreeRSS, watch } from "../lib/resources.mjs";

const KEY = "ANTHROPIC_API_KEY";

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("safeEnv deletes risky keys and keeps everything else", () => {
  withEnv({ [KEY]: "sk-paid", AGENTKIT_TEST_KEEP: "keep-me" }, () => {
    const env = safeEnv({ EXTRA_ONE: "1" });
    assert.ok(!(KEY in env), "the risky key must be absent, not empty");
    assert.equal(env.AGENTKIT_TEST_KEEP, "keep-me");
    assert.equal(env.EXTRA_ONE, "1");
    assert.equal(env.PATH, process.env.PATH);
    for (const k of RISKY_ENV) assert.ok(!(k in env), k);
  });
});

test("riskyEnvPresent finds a set var and ignores an empty one", () => {
  withEnv({ [KEY]: "sk-paid", OPENAI_API_KEY: "" }, () => {
    const found = riskyEnvPresent();
    assert.ok(found.includes(KEY));
    assert.ok(!found.includes("OPENAI_API_KEY"), "an empty value routes nowhere");
  });
});

test("capacity reports real numbers for this machine", () => {
  const cap = capacity();
  assert.ok(cap.cores > 0, `cores=${cap.cores}`);
  assert.ok(cap.perfCores > 0 && cap.perfCores <= cap.cores);
  assert.ok(cap.ramTotalGB > 0, `ramTotalGB=${cap.ramTotalGB}`);
  assert.ok(cap.ramAvailGB >= 0 && cap.ramAvailGB <= cap.ramTotalGB);
  assert.ok(cap.diskFreeGB >= 0);
  assert.equal(typeof cap.loadPerCore, "number");
});

test("maxConcurrency stays in range and shrinks with RAM", () => {
  const n = maxConcurrency();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 8, `got ${n}`);

  const roomy = { cores: 14, perfCores: 10, ramTotalGB: 36, ramAvailGB: 30, diskFreeGB: 300, load1: 1, loadPerCore: 0.07 };
  const tight = { ...roomy, ramAvailGB: 7 };
  assert.equal(maxConcurrency(DEFAULT_LIMITS, roomy), 8, "capped by the hard ceiling");
  // A file-editing run peaked at 1.4 GB; one that installed deps and ran a build
  // peaked at 4.5 GB. Admission assumes 2.5 GB — the heavier case.
  assert.equal(maxConcurrency(DEFAULT_LIMITS, tight), 1, "(7 - 6) GB / 2.5 GB rounds to none, floor is 1");
  assert.equal(maxConcurrency(DEFAULT_LIMITS, { ...roomy, ramAvailGB: 16 }), 4, "(16 - 6) GB / 2.5 GB");
  assert.equal(maxConcurrency(DEFAULT_LIMITS, { ...roomy, ramAvailGB: 6 }), 1, "never below 1");
});

test("admits refuses on low RAM, full disk, high load and at the cap", () => {
  const cap = { cores: 14, perfCores: 10, ramTotalGB: 36, ramAvailGB: 30, diskFreeGB: 300, load1: 1, loadPerCore: 0.07 };
  assert.equal(admits(0, DEFAULT_LIMITS, cap).ok, true);

  const noRam = admits(0, DEFAULT_LIMITS, { ...cap, ramAvailGB: 6.1 });
  assert.equal(noRam.ok, false);
  assert.match(noRam.reason, /^RAM: /);

  const atCap = admits(8, DEFAULT_LIMITS, cap);
  assert.equal(atCap.ok, false);
  assert.match(atCap.reason, /^Concurrency: /);
  assert.ok(atCap.waitMs > 0);

  assert.match(admits(0, DEFAULT_LIMITS, { ...cap, diskFreeGB: 3 }).reason, /^Disk: /);
  assert.match(admits(0, DEFAULT_LIMITS, { ...cap, loadPerCore: 4 }).reason, /^Load: /);
});

test("processTreeRSS measures this very process", () => {
  assert.ok(processTreeRSS(process.pid) > 0);
  assert.equal(processTreeRSS(0x7ffffff), 0, "a missing pid weighs nothing");
});

test("watch returns a handle and never holds the event loop open", () => {
  const w = watch(process.pid, { maxRssMB: 1e9, maxMs: 1e9, intervalMs: 10 });
  assert.equal(typeof w.stop, "function");
  assert.equal(typeof w.peakRssMB(), "number");
  w.stop();
  w.stop(); // stopping twice must be harmless
});

test("token accounting counts a request once, not once per content block", async () => {
  const u = await import("../lib/usage.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-usage-"));
  const proj = path.join(dir, ".claude", "projects", "-x");
  fs.mkdirSync(proj, { recursive: true });
  // Claude Code writes one line per content block, each carrying the same
  // message id and the same usage. Counting every line inflated the total 2.7x.
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const line = (id) => JSON.stringify({ timestamp: new Date().toISOString(), message: { id, model: "claude-opus-5", usage } });
  fs.writeFileSync(path.join(proj, "s.jsonl"), [line("m1"), line("m1"), line("m1"), line("m2")].join("\n"));

  const home = process.env.HOME;
  process.env.HOME = dir;
  try {
    const { totals } = u.spentSince(0);
    assert.equal(totals.requests, 2, "three lines of one message are one request");
    assert.equal(totals.output, 10);
    assert.equal(totals.cacheRead, 200);
  } finally {
    process.env.HOME = home;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unknown or smaller model does not get a 1M context window", async () => {
  const { contextWindow } = await import("../lib/usage.mjs");
  assert.equal(contextWindow("claude-opus-5"), 1_000_000);
  assert.equal(contextWindow("claude-opus-4-8"), 1_000_000);
  // Reporting a 200k model as 1M would hide a full context and the lead would never rotate.
  assert.equal(contextWindow("claude-opus-4-1"), 200_000);
  assert.equal(contextWindow("claude-haiku-4-5"), 200_000);
  assert.equal(contextWindow("something-new"), 200_000);
});
