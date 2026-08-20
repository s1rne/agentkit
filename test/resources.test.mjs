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

test("priority gets one reserved slot, never a weaker safety limit", async () => {
  const { admits, DEFAULT_LIMITS, maxConcurrency } = await import("../lib/resources.mjs");
  const roomy = { cores: 14, perfCores: 10, ramTotalGB: 36, ramAvailGB: 30, diskFreeGB: 300, load1: 1, loadPerCore: 0.07 };
  const max = maxConcurrency(DEFAULT_LIMITS, roomy);

  // At the cap: ordinary work waits, work with a queue behind it does not.
  assert.equal(admits(max, DEFAULT_LIMITS, roomy).ok, false);
  assert.equal(admits(max, DEFAULT_LIMITS, roomy, { priority: true }).ok, true);
  // One reserved slot, not an open door.
  assert.equal(admits(max + 1, DEFAULT_LIMITS, roomy, { priority: true }).ok, false);

  // Priority moves the queue, never the machine's limits.
  const starved = { ...roomy, ramAvailGB: 6.2 };
  assert.equal(admits(0, DEFAULT_LIMITS, starved, { priority: true }).ok, false);
  const fullDisk = { ...roomy, diskFreeGB: 5 };
  assert.equal(admits(0, DEFAULT_LIMITS, fullDisk, { priority: true }).ok, false);
});

/** A cgroup hierarchy on disk, as the kernel would lay it out. */
function fakeCgroup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-cg-"));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, "utf8");
  }
  return dir;
}

test("in a container the limit is the container's, not the machine's", () => {
  const GB = 1024 ** 3;
  const dir = fakeCgroup({
    "memory.max": `${4 * GB}\n`,
    "memory.current": `${2 * GB}\n`,
    // Half of what is "used" is page cache the kernel gives back under pressure.
    "memory.stat": `anon 1073741824\ninactive_file ${GB}\nslab 0\n`,
    "cpu.max": "200000 100000\n",
  });
  withEnv({ AGENTKIT_CGROUP_ROOT: dir }, () => {
    const cap = capacity(dir);
    assert.equal(cap.dedicated, true, "the limit came from a cgroup");
    assert.equal(cap.ramTotalGB, 4, "the host's 64 GB are none of our business");
    assert.equal(cap.ramAvailGB, 3, "4 GB, 2 GB used, 1 GB of that reclaimable cache");
    assert.ok(cap.perfCores <= 2, `cpu.max grants two cores, got ${cap.perfCores}`);

    // The whole point: four gigabytes hold one agent of ~2.5 GB, not eight.
    // Eight was what the host's free memory suggested, and the OOM killer then
    // took them out one by one — which looked like runs failing at random.
    assert.equal(maxConcurrency(DEFAULT_LIMITS, cap), 1);
    const gate = admits(0, DEFAULT_LIMITS, cap);
    assert.equal(gate.ok, false, "and it says so instead of starting one anyway");
    assert.match(gate.reason, /^RAM: 3 GB available/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("where nobody shares the memory, nothing is reserved for a human", () => {
  const GB = 1024 ** 3;
  const dir = fakeCgroup({
    "memory.max": `${8 * GB}\n`,
    "memory.current": `${GB}\n`,
    "memory.stat": "inactive_file 0\n",
    "cpu.max": "400000 100000\n",
  });
  withEnv({ AGENTKIT_CGROUP_ROOT: dir }, () => {
    const cap = capacity(dir);
    // Six gigabytes are held back for an editor and a browser on a laptop. Held
    // back inside an eight-gigabyte container they would leave room for nobody,
    // and the fleet would refuse every run forever.
    assert.equal(maxConcurrency(DEFAULT_LIMITS, cap), 2);
    const gate = admits(0, DEFAULT_LIMITS, cap);
    assert.ok(gate.ok || !/^RAM/.test(gate.reason), gate.reason);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cgroup v1, and an unlimited cgroup, are read correctly too", () => {
  const GB = 1024 ** 3;
  const v1 = fakeCgroup({
    "memory/memory.limit_in_bytes": `${16 * GB}\n`,
    "memory/memory.usage_in_bytes": `${GB}\n`,
    "memory/memory.stat": "inactive_file 0\n",
    "cpu/cpu.cfs_quota_us": "800000\n",
    "cpu/cpu.cfs_period_us": "100000\n",
  });
  withEnv({ AGENTKIT_CGROUP_ROOT: v1 }, () => {
    const cap = capacity(v1);
    assert.equal(cap.ramTotalGB, 16);
    assert.equal(cap.ramAvailGB, 15);
    assert.equal(maxConcurrency(DEFAULT_LIMITS, cap), 5, "(15 - 1) GB over 2.5 GB an agent");
  });
  fs.rmSync(v1, { recursive: true, force: true });

  // "max" is how v2 spells "no limit": fall back to what the machine reports.
  const none = fakeCgroup({ "memory.max": "max\n", "memory.current": "12345\n", "cpu.max": "max 100000\n" });
  withEnv({ AGENTKIT_CGROUP_ROOT: none }, () => {
    const cap = capacity(none);
    assert.equal(cap.dedicated, false);
    assert.equal(cap.ramTotalGB, Math.round((os.totalmem() / 1024 ** 3) * 100) / 100);
  });
  fs.rmSync(none, { recursive: true, force: true });
});
