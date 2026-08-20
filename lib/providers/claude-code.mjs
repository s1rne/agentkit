import { execFile } from "node:child_process";
import { safeEnv } from "../env.mjs";

export const id = "claude-code";
export const label = "Claude Code";
export const bin = "claude";
export const capabilities = ["code", "big-context", "plan-mode", "parallel"];
export const configDirEnv = "CLAUDE_CONFIG_DIR";
/**
 * Verified: an empty CLAUDE_CONFIG_DIR reports loggedIn:false, so the config
 * directory really is where the credential lives.
 */
export const isolation = "config-dir";
/** Has a permission mode between read-only and run-everything (`acceptEdits`). */
export const sharedWriteSafe = true;
/**
 * Can run commands while refusing to write: the write tools are withheld by
 * name, independently of the permission mode. That is what lets a reviewer
 * confirm by running instead of by reading. Whatever a command writes through
 * the shell is outside the promise — the withheld tools are.
 */
export const canRunWithoutWriting = true;

const PROBE_TIMEOUT_MS = 8000;
const LOGIN_HINT = `run: ${bin} auth login`;

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
 * Cheap login check — `claude auth status` prints JSON and never calls a model.
 * The probe runs under safeEnv() too, so it reports the auth the spawned agent
 * will actually get, not the one an inherited API key would fake.
 */
export async function probe({ configDir } = {}) {
  const env = safeEnv(configDir ? { [configDirEnv]: configDir } : {});
  const r = await run(bin, ["auth", "status"], env);

  if (r.failure === "absent") {
    return state("absent", { installed: false }, "install it: npm i -g @anthropic-ai/claude-code");
  }
  if (r.failure === "timeout") {
    return state("not-logged-in", { installed: true, timedOut: true }, `\`${bin} auth status\` hung for 8s — run it by hand`);
  }

  const data = firstJson(r.stdout) || firstJson(r.stderr);
  if (!data) {
    return state("not-logged-in", { installed: true, unparsable: true }, LOGIN_HINT);
  }

  const detail = {
    authMethod: data.authMethod ?? null,
    apiProvider: data.apiProvider ?? null,
    subscriptionType: data.subscriptionType ?? null,
    email: data.email ?? null,
  };

  if (!data.loggedIn) return state("not-logged-in", detail, LOGIN_HINT);

  // Subscription auth is exactly this pair. Anything else bills per token.
  const subscription = detail.authMethod === "claude.ai" && detail.apiProvider === "firstParty";
  if (!subscription) {
    return state(
      "metered",
      detail,
      `this login bills per token (authMethod=${detail.authMethod}, apiProvider=${detail.apiProvider}) — run: ${bin} auth logout && ${bin} auth login`
    );
  }
  return state("ready", detail, null);
}

/**
 * How a permission level maps onto this CLI's permission modes.
 *
 * `plan` forbids running as well as writing, so a role that has to confirm by
 * running gets `verify` instead: the write tools are withheld by name, which is
 * what actually keeps it from changing anything.
 */
const PERMISSION = {
  read: "plan",              // look, do not run, do not write
  verify: "bypassPermissions", // run the tests; the write tools are withheld below
  edit: "acceptEdits",       // the human's own directory: edits yes, arbitrary commands no
  isolated: "bypassPermissions", // a worktree or a copy — that is what the isolation is for
};

const NO_WRITE_TOOLS = ["read", "verify"];

/**
 * Headless run spec. --verbose is not optional: --print with stream-json
 * refuses to start without it. Without an explicit permission mode a headless
 * run stops on the first write and reports back asking a human to approve.
 */
export function spawnSpec({ prompt, model, cwd, configDir, permission = "edit", extraArgs = [] } = {}) {
  if (!prompt) throw new Error("claude-code: prompt is required");
  const args = ["-p", String(prompt), "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", PERMISSION[permission] || PERMISSION.edit);
  if (NO_WRITE_TOOLS.includes(permission)) args.push("--disallowed-tools", "Edit", "Write", "NotebookEdit");
  if (model) args.push("--model", String(model));
  args.push(...extraArgs);
  return {
    cmd: bin,
    args,
    env: safeEnv(configDir ? { [configDirEnv]: configDir } : {}),
    cwd: cwd || process.cwd(),
  };
}

function usageOf(u) {
  if (!u || typeof u !== "object") return null;
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
}

function rateLimitOf(info) {
  if (!info || typeof info !== "object") return null;
  const at = Number(info.resetsAt);
  return {
    status: info.status ?? null,
    type: info.rateLimitType ?? null,
    resetsAt: Number.isFinite(at) ? new Date(at * 1000).toISOString() : null,
    isUsingOverage: info.isUsingOverage === true,
  };
}

const empty = (error) => ({
  ok: false,
  text: "",
  usage: null,
  cost: null,
  durationMs: null,
  turns: null,
  stopReason: null,
  sessionId: null,
  rateLimit: null,
  error,
});

/** JSONL in, one flat record out. Malformed lines are skipped, never thrown on. */
export function parseStream(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return empty("empty output: the CLI printed nothing");

  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") events.push(e);
    } catch {
      // a torn or interleaved line — ignore it
    }
  }
  if (events.length === 0) return empty("no parsable JSON events in the output");

  let result = null;
  let rateLimit = null;
  let sessionId = null;
  const chunks = [];

  for (const e of events) {
    if (e.session_id) sessionId = e.session_id;
    if (e.type === "result") result = e;
    else if (e.type === "rate_limit_event") rateLimit = rateLimitOf(e.rate_limit_info) || rateLimit;
    else if (e.type === "assistant") {
      for (const part of e.message?.content ?? []) {
        if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
      }
    }
  }

  if (!result) {
    const partial = chunks.join("");
    return {
      ...empty("stream ended without a result event (the run was cut short)"),
      text: partial,
      sessionId,
      rateLimit,
    };
  }

  const failed = result.is_error === true || result.subtype !== "success";

  /**
   * Оборванный прогон не должен пропадать целиком.
   *
   * На обрыве соединения `result.result` несёт текст ошибки, а всё, что агент
   * успел сказать, лежит в `assistant`-событиях. Раньше отчёт на четыреста
   * тысяч токенов терялся ради одной строки «Connection closed». Берём то, что
   * длиннее и содержательнее: работа стоит дороже, чем её эпитафия.
   */
  const streamed = chunks.join("");
  const final = typeof result.result === "string" ? result.result : "";
  // При обрыве в поле `result` лежит извещение об ошибке, а не отчёт. Признак —
  // именно это, а не длина: короткий отчёт бывает короче длинного сообщения об
  // ошибке, и сравнение длин выберет ровно не то.
  const isNotice = /^(api error|error:|connection closed|request (timed out|failed))/i.test(final.trim());
  const report = failed && isNotice && streamed ? streamed : final || streamed;

  return {
    ok: !failed,
    text: report,
    partial: failed && streamed.length > 0 ? true : undefined,
    usage: usageOf(result.usage),
    cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    durationMs: typeof result.duration_ms === "number" ? result.duration_ms : null,
    turns: typeof result.num_turns === "number" ? result.num_turns : null,
    stopReason: result.stop_reason ?? null,
    sessionId: result.session_id ?? sessionId,
    rateLimit,
    // `subtype` при обрыве остаётся "success" — писать это причиной отказа
    // бессмысленно. Настоящая причина в тексте ошибки или в статусе API.
    error: failed
      ? String(
          result.api_error_status ||
            (isNotice ? final.split("\n")[0].slice(0, 160) : "") ||
            (result.subtype !== "success" ? result.subtype : "") ||
            "прогон завершился ошибкой"
        )
      : null,
  };
}
