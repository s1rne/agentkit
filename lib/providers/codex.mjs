import { execFile } from "node:child_process";

export const id = "codex";
export const label = "Codex CLI";
export const bin = "codex";
export const capabilities = ["code"];
export const sharedWriteSafe = false;
export const isolation = null;
// No config-dir isolation is wired up yet, so two accounts cannot be separated.
export const configDirEnv = null;

const PROBE_TIMEOUT_MS = 8000;
const UNSUPPORTED = "the Codex adapter is not written yet — use claude-code or cursor";

/** Read-only CLI call that never throws. Resolves { failure }. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (error) =>
      resolve({ failure: !error ? null : error.code === "ENOENT" ? "absent" : "exit" })
    );
  });
}

/**
 * Always reports 'absent'. The binary may well be installed, but the login
 * check, the flag set and the stream schema are all unverified here — and
 * 'absent' is the only state the router refuses to select, which is what we
 * want until someone captures a real run.
 */
export async function probe() {
  const r = await run(bin, ["--version"]);
  const installed = r.failure !== "absent";
  return {
    id,
    state: "absent",
    detail: { installed, supported: false },
    hint: installed ? UNSUPPORTED : "not installed, and not supported yet either",
  };
}

export function spawnSpec() {
  throw new Error(`codex: ${UNSUPPORTED}`);
}

export function parseStream() {
  return {
    ok: false,
    text: "",
    usage: null,
    cost: null,
    durationMs: null,
    turns: null,
    stopReason: null,
    sessionId: null,
    rateLimit: null,
    error: UNSUPPORTED,
  };
}
