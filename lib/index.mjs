/**
 * The library surface.
 *
 * Everything here was written to be called: `run()` takes the project root and
 * the config as arguments and reads no global state, `probeAll()` never throws,
 * `route()` returns the reason it refused instead of raising. A long-lived
 * service that drives several repositories at once should be able to call a
 * function and get an object back, rather than spawning the CLI and parsing
 * what it printed for a human.
 *
 * What is exported here is what will not be renamed under a caller. Everything
 * else stays private and is free to change.
 */
export * as accounts from "./accounts.mjs";
export * as boxes from "./boxes.mjs";
export * as orchestrator from "./orchestrator.mjs";
export * as providers from "./providers/index.mjs";
export * as resources from "./resources.mjs";
export * as team from "./team.mjs";
export * as usage from "./usage.mjs";
export * as wave from "./wave.mjs";

// The two calls a caller reaches for first: run one agent, or carry one task
// through the whole cycle.
export { run } from "./orchestrator.mjs";
export { carry, ready } from "./wave.mjs";
