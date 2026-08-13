import fs from "node:fs";
import path from "node:path";
import { readDir, parseFront, stringifyFront, write, upsertBlock, activeRoles, block, strings, ok } from "../util.mjs";
import { messages } from "../i18n.mjs";

export const id = "claude-code";
export const label = "Claude Code";

export function generate(root, cfg) {
  const src = path.join(root, ".agentkit");
  const out = path.join(root, ".claude");
  const t = messages(cfg.project?.language);
  const s = strings(root);
  let n = 0;

  // Roles → subagents
  for (const r of activeRoles(root, cfg)) {
    const front = {
      name: r.name,
      description: r.data.description,
      tools: r.data.tools,
    };
    write(path.join(out, "agents", `${r.name}.md`), stringifyFront(front, r.body));
    n++;
  }

  // Skills → .claude/skills/<name>/SKILL.md
  for (const f of readDir(path.join(src, "skills"))) {
    const { data, body } = parseFront(fs.readFileSync(path.join(src, "skills", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    write(
      path.join(out, "skills", name, "SKILL.md"),
      stringifyFront({ name, description: data.description }, body)
    );
    n++;
  }

  // Commands
  for (const f of readDir(path.join(src, "commands"))) {
    const { data, body } = parseFront(fs.readFileSync(path.join(src, "commands", f), "utf8"));
    write(
      path.join(out, "commands", f),
      stringifyFront({ description: data.description }, body)
    );
    n++;
  }

  // Managed block in CLAUDE.md
  const byGroup = {};
  for (const r of activeRoles(root, cfg)) (byGroup[r.data.group || s.otherGroup] ||= []).push(r.name);
  const table = Object.entries(byGroup)
    .map(([g, list]) => `| ${g} | ${list.map((x) => "`" + x + "`").join(" · ")} |`)
    .join("\n");

  const b = block(root, "claude-code", { ROLES_TABLE: table });
  const st = b ? upsertBlock(path.join(root, "CLAUDE.md"), b.text) : "unchanged";
  ok(t.claudeDone(n, t[`block${st[0].toUpperCase()}${st.slice(1)}`]));
}
