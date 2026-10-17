import fs from "node:fs";
import path from "node:path";
import { parseFront, stringifyFront, write } from "./util.mjs";
import { zipDir } from "./zip.mjs";

/**
 * Протоколы, которые работают без рантайма agentkit: в них нет `agentkit run`,
 * боксов и файлов .agentkit/. Остальные без CLI теряют смысл и наружу не идут.
 * Роль рядом со скиллом едет как сабагент — для хостов, которые их понимают.
 */
export const PORTABLE = {
  "adversarial-review": { agents: ["critic"] },
  "definition-of-done": {},
  "context-budget": {},
  "no-ai-attribution": {},
  "handoff-protocol": {},
  "memory-protocol": {},
  "task-protocol": { agents: ["planner"] },
};

/** Собирает папки `<out>/<skill>/SKILL.md` (+ agents/) и, по желанию, zip рядом. */
export function exportSkills(pkg, { lang = "en", out, names, zip = false }) {
  const tpl = path.join(pkg, "template", lang);
  const pick = names?.length ? names : Object.keys(PORTABLE);
  const done = [];

  for (const name of pick) {
    if (!PORTABLE[name]) throw new Error(`not portable: ${name} (portable: ${Object.keys(PORTABLE).join(", ")})`);
    const { data, body } = parseFront(fs.readFileSync(path.join(tpl, "skills", `${name}.md`), "utf8"));
    const dir = path.join(out, name);
    fs.rmSync(dir, { recursive: true, force: true });
    write(path.join(dir, "SKILL.md"), stringifyFront({ name, description: data.description }, body));

    for (const role of PORTABLE[name].agents || []) {
      const r = parseFront(fs.readFileSync(path.join(tpl, "roles", `${role}.md`), "utf8"));
      write(
        path.join(dir, "agents", `${role}.md`),
        stringifyFront({ name: role, description: r.data.description, tools: r.data.tools }, r.body)
      );
    }

    done.push({ name, dir, zip: zip ? zipDir(dir, path.join(out, `${name}.zip`), name) : null });
  }
  return done;
}
