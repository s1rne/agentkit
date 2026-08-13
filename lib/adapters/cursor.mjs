import fs from "node:fs";
import path from "node:path";
import { readDir, parseFront, write, activeRoles, ok } from "../util.mjs";

export const id = "cursor";
export const label = "Cursor";

function mdc(front, body) {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function generate(root, cfg) {
  const src = path.join(root, ".agentkit");
  const out = path.join(root, ".cursor", "rules");
  let n = 0;

  // Всегда активные протоколы — ядро процесса
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

  // Роли: в Cursor нет субагентов — роль становится вызываемым шаблоном
  const roles = activeRoles(root, cfg);
  const rolesDoc = roles
    .map(
      (r) => `### ${r.name}\n\n${r.data.description}\n\n<details><summary>Правила роли</summary>\n\n${r.body.trim()}\n\n</details>`
    )
    .join("\n\n---\n\n");

  write(
    path.join(out, "agentkit-roles.mdc"),
    mdc(
      {
        description:
          "Роли команды. В Cursor нет субагентов — чтобы работать в роли, скажи «действуй как <роль>» и следуй её правилам.",
        alwaysApply: false,
      },
      `# Роли команды\n\nВ Cursor роли не изолированы в отдельные контексты. Чтобы работать в роли, явно скажи: «действуй как \`critic\`» — и следуй её правилам ниже. Параллельный запуск недоступен: задачи идут последовательно.\n\n${rolesDoc}`
    )
  );
  n++;
  ok(`Cursor: ${n} правил в .cursor/rules/`);
}
