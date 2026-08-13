/**
 * Child agents must authenticate through their own CLI subscription login.
 * A single inherited key silently routes them to a metered API instead —
 * so the whole list is stripped from the environment we hand down.
 */
export const RISKY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
];

/** Which of the risky vars are set and non-empty right now. */
export function riskyEnvPresent(env = process.env) {
  return RISKY_ENV.filter((k) => typeof env[k] === "string" && env[k].trim() !== "");
}

/**
 * A copy of the environment with every risky key removed — really removed,
 * not blanked, so the child CLI falls back to its stored subscription login.
 */
export function safeEnv(extra = {}, env = process.env) {
  const out = { ...env };
  for (const k of RISKY_ENV) delete out[k];
  return { ...out, ...extra };
}
