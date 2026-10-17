import path from "node:path";
import { upsertBlock, activeRoles, block, ok } from "../util.mjs";
import { messages } from "../i18n.mjs";

export const id = "copilot";
export const label = "GitHub Copilot";

// Copilot reads repository instructions from .github/copilot-instructions.md.
// It has no subagents either, so the text is the same block as AGENTS.md.
export function generate(root, cfg) {
  const t = messages(cfg.project?.language);
  const list = activeRoles(root, cfg)
    .map((r) => `- **${r.name}** — ${r.data.description}`)
    .join("\n");

  const b = block(root, "agents-md", { ROLES_LIST: list });
  const st = b ? upsertBlock(path.join(root, ".github", "copilot-instructions.md"), b.text) : "unchanged";
  ok(t.copilotDone(t[`block${st[0].toUpperCase()}${st.slice(1)}`]));
}
