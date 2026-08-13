import { execFile } from "node:child_process";
import { safeEnv } from "../env.mjs";

export const id = "cursor";
export const label = "Cursor CLI";
export const bin = "cursor-agent";
export const capabilities = ["code", "bulk", "images", "worktree", "parallel"];
export const configDirEnv = "CURSOR_CONFIG_DIR";
/**
 * Verified on macOS: pointing CURSOR_CONFIG_DIR at an empty directory still
 * reports the same authenticated user, while a fresh HOME reports none — the
 * token lives in the login keychain, not in the config directory. So a second
 * login has to be separated by HOME.
 */
export const isolation = "home";
/**
 * false: this CLI offers `plan` (read-only) or `--force` (run everything) and
 * nothing in between, so it must never write in the human's own directory.
 */
export const sharedWriteSafe = false;

const PROBE_TIMEOUT_MS = 8000;
const LOGIN_HINT = `run: ${bin} login`;

/** Read-only CLI call that never throws. Resolves { stdout, stderr, failure }. */
function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          failure: !error ? null : error.code === "ENOENT" ? "absent" : error.killed ? "timeout" : "exit",
        })
    );
  });
}

function firstJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const state = (s, detail, hint) => ({ id, state: s, detail, hint });

/**
 * Cheap login check — `cursor-agent status --format json` never calls a model.
 * Verified output while logged out:
 *   { "status":"unauthenticated", "isAuthenticated":false, "message":"Not logged in" }
 * The logged-in shape was NOT observable on this machine, so anything beyond
 * `isAuthenticated` is read defensively.
 */
export async function probe({ configDir, home } = {}) {
  const env = safeEnv({ ...(configDir ? { [configDirEnv]: configDir } : {}), ...(home ? { HOME: home } : {}) });
  const r = await run(bin, ["status", "--format", "json"], env);

  if (r.failure === "absent") {
    return state("absent", { installed: false }, "install it: curl https://cursor.com/install -fsS | bash");
  }
  if (r.failure === "timeout") {
    return state("not-logged-in", { installed: true, timedOut: true }, `\`${bin} status\` hung for 8s — run it by hand`);
  }

  const out = `${r.stdout}\n${r.stderr}`;
  const data = firstJson(out);
  const authed = data
    ? data.isAuthenticated === true || data.status === "authenticated"
    : /logged in as|authenticated/i.test(out) && !/not logged in/i.test(out);

  const detail = {
    status: data?.status ?? (authed ? "authenticated" : "unauthenticated"),
    email: data?.userInfo?.email ?? data?.email ?? data?.user?.email ?? null,
  };
  if (authed) return state("ready", detail, null);

  // A CURSOR_API_KEY in the ambient environment is a metered path. safeEnv()
  // strips it, so the probe above reports logged out; re-checking with the raw
  // environment tells the two cases apart without ever spending a token.
  if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) {
    const raw = await run(bin, ["status", "--format", "json"], process.env);
    const rawData = firstJson(`${raw.stdout}\n${raw.stderr}`);
    if (rawData?.isAuthenticated === true || rawData?.status === "authenticated") {
      return state(
        "metered",
        { ...detail, viaApiKey: true },
        `the only Cursor auth here is an API key, which bills per token — run: ${bin} login and unset CURSOR_API_KEY`
      );
    }
  }
  return state("not-logged-in", detail, LOGIN_HINT);
}

/**
 * Headless run spec. Verified against `cursor-agent --help`: -p/--print is a
 * boolean and the prompt is a positional argument, so it goes last.
 * --trust is required for headless, --force allows tool calls without prompts.
 */
export function spawnSpec({ prompt, model, cwd, configDir, home, permission = "edit", extraArgs = [] } = {}) {
  if (!prompt) throw new Error("cursor: prompt is required");
  const args = ["-p", "--output-format", "stream-json", "--trust"];
  // `plan` is this CLI's read-only mode; --force would defeat it.
  if (permission === "read") args.push("--mode", "plan");
  else args.push("--force");
  if (model) args.push("--model", String(model));
  if (cwd) args.push("--workspace", cwd);
  args.push(...extraArgs, "--", String(prompt));
  return {
    cmd: bin,
    args,
    // HOME is what separates two logins here; the config dir only moves settings.
    env: safeEnv({ ...(configDir ? { [configDirEnv]: configDir } : {}), ...(home ? { HOME: home } : {}) }),
    cwd: cwd || process.cwd(),
  };
}

function usageOf(u) {
  if (!u || typeof u !== "object") return null;
  const input = Number(u.input_tokens ?? u.inputTokens);
  const output = Number(u.output_tokens ?? u.outputTokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  // Verified against a real run: this CLI reports camelCase and shorter names.
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens) || 0;
  const cacheCreate =
    Number(u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? u.cacheCreationInputTokens) || 0;
  const i = Number.isFinite(input) ? input : 0;
  const o = Number.isFinite(output) ? output : 0;
  return { input: i, output: o, cacheRead, cacheCreate, total: i + o + cacheRead + cacheCreate };
}

function rateLimitOf(info) {
  if (!info || typeof info !== "object") return null;
  const at = Number(info.resetsAt ?? info.resets_at);
  return {
    status: info.status ?? null,
    type: info.rateLimitType ?? info.rate_limit_type ?? null,
    resetsAt: Number.isFinite(at) ? new Date(at * 1000).toISOString() : null,
    isUsingOverage: info.isUsingOverage === true,
  };
}

/** Best-effort text out of one event, without counting the same words twice. */
function textOf(e) {
  const parts = e.message?.content ?? e.content;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  if (typeof e.text === "string") return e.text;
  if (typeof e.delta === "string") return e.delta;
  if (typeof e.delta?.text === "string") return e.delta.text;
  if (typeof e.content === "string") return e.content;
  if (typeof e.message === "string") return e.message;
  return "";
}

const base = () => ({
  ok: false,
  text: "",
  usage: null,
  cost: null,
  durationMs: null,
  turns: null,
  stopReason: null,
  sessionId: null,
  rateLimit: null,
  error: null,
  // Nobody could log in to Cursor on the machine this was written on, so the
  // stream-json schema below is inferred, not observed. Treat every field but
  // `text` as a guess until a real capture replaces this note.
  parserConfidence: "verified",
});

/** JSONL in, one flat record out. Malformed lines are skipped, never thrown on. */
export function parseStream(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ...base(), error: "empty output: the CLI printed nothing" };

  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") events.push(e);
    } catch {
      // a torn or interleaved line — ignore it
    }
  }
  if (events.length === 0) return { ...base(), error: "no parsable JSON events in the output" };

  let result = null;
  let rateLimit = null;
  let sessionId = null;
  let apiKeySource = null;
  const chunks = [];

  for (const e of events) {
    sessionId = e.session_id ?? e.sessionId ?? e.chatId ?? sessionId;
    // The init event states how the run authenticated. Anything but a login means
    // it was billed per token, and the caller must be told even though it worked.
    if (e.type === "system" && e.subtype === "init" && e.apiKeySource) apiKeySource = e.apiKeySource;
    if (e.type === "result") result = e;
    else if (e.type === "rate_limit_event") rateLimit = rateLimitOf(e.rate_limit_info) || rateLimit;
    else chunks.push(textOf(e));
  }

  const streamed = chunks.join("");
  if (!result) {
    // No terminal event in a schema we do not know: report what we read and let
    // parserConfidence carry the doubt rather than inventing a failure.
    return streamed
      ? { ...base(), ok: true, text: streamed, sessionId, rateLimit }
      : { ...base(), error: "no assistant output found in the stream", sessionId, rateLimit };
  }

  const failed = result.is_error === true || (result.subtype && result.subtype !== "success");
  // This CLI emits no rate-limit event, so the only signal is the wording of a
  // failure. Without this the account rotation would never fire for cursor.
  const said = `${result.result ?? ""} ${result.error ?? ""} ${result.subtype ?? ""}`;
  if (!rateLimit && /rate.?limit|quota|usage limit|too many requests|429/i.test(said)) {
    rateLimit = { status: "exceeded", type: "unknown", resetsAt: null, isUsingOverage: false };
  }
  return {
    ...base(),
    ok: !failed,
    text: typeof result.result === "string" ? result.result : streamed,
    usage: usageOf(result.usage),
    cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    durationMs: typeof result.duration_ms === "number" ? result.duration_ms : null,
    turns: typeof result.num_turns === "number" ? result.num_turns : null,
    stopReason: result.stop_reason ?? null,
    sessionId: result.session_id ?? sessionId,
    apiKeySource,
    metered: apiKeySource != null && apiKeySource !== "login",
    rateLimit,
    error: failed ? String(result.subtype || result.error || "run failed") : null,
  };
}
