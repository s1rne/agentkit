import fs from "node:fs";
import path from "node:path";
import { readDir, parseFront, write, activeRoles, block, strings, ok } from "../util.mjs";
import { messages } from "../i18n.mjs";

export const id = "cursor";
export const label = "Cursor";

function mdc(front, body) {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function generate(root, cfg) {
  const src = path.join(root, ".agentkit");
  const out = path.join(root, ".cursor", "rules");
  const t = messages(cfg.project?.language);
  const s = strings(root);
  let n = 0;

  // Always-on protocols — the core of the process
  const always = new Set(cfg.cursor?.alwaysApply || ["team-protocol", "tech-lead", "task-protocol"]);

  for (const f of readDir(path.join(src, "skills"))) {
    const { data, body } = parseFront(fs.readFileSync(path.join(src, "skills", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    write(
      path.join(out, `agentkit-${name}.mdc`),
      mdc({ description: data.description, alwaysApply: always.has(name) }, body)
    );
    n++;
  }

  // Roles: Cursor has no subagents — a role becomes an invocable template
  const rolesDoc = activeRoles(root, cfg)
    .map(
      (r) => `### ${r.name}\n\n${r.data.description}\n\n<details><summary>${s.roleRules}</summary>\n\n${r.body.trim()}\n\n</details>`
    )
    .join("\n\n---\n\n");

  const b = block(root, "cursor-roles", { ROLES_DOC: rolesDoc });
  if (b) {
    write(
      path.join(out, "agentkit-roles.mdc"),
      mdc({ description: b.data.description, alwaysApply: false }, b.text)
    );
    n++;
  }
  ok(t.cursorDone(n));
}
