import path from "node:path";
import { upsertBlock, activeRoles, block, ok } from "../util.mjs";
import { messages } from "../i18n.mjs";

export const id = "agents-md";
export const label = "AGENTS.md (Codex and compatible)";

export function generate(root, cfg) {
  const t = messages(cfg.project?.language);
  const list = activeRoles(root, cfg)
    .map((r) => `- **${r.name}** — ${r.data.description}`)
    .join("\n");

  const b = block(root, "agents-md", { ROLES_LIST: list });
  const st = b ? upsertBlock(path.join(root, "AGENTS.md"), b.text) : "unchanged";
  ok(t.agentsMdDone(t[`block${st[0].toUpperCase()}${st.slice(1)}`]));
}
