import fs from "node:fs";
import path from "node:path";
import { readDir, parseFront, stringifyFront, write, upsertBlock, activeRoles, ok } from "../util.mjs";

export const id = "claude-code";
export const label = "Claude Code";

export function generate(root, cfg) {
  const src = path.join(root, ".agentkit");
  const out = path.join(root, ".claude");
  let n = 0;

  // Роли → субагенты
  for (const r of activeRoles(root, cfg)) {
    const front = {
      name: r.name,
      description: r.data.description,
      tools: r.data.tools,
    };
    write(path.join(out, "agents", `${r.name}.md`), stringifyFront(front, r.body));
    n++;
  }

  // Навыки → .claude/skills/<name>/SKILL.md
  for (const f of readDir(path.join(src, "skills"))) {
    const { data, body } = parseFront(fs.readFileSync(path.join(src, "skills", f), "utf8"));
    const name = data.name || f.replace(/\.md$/, "");
    write(
      path.join(out, "skills", name, "SKILL.md"),
      stringifyFront({ name, description: data.description }, body)
    );
    n++;
  }

  // Команды
  for (const f of readDir(path.join(src, "commands"))) {
    const { data, body } = parseFront(fs.readFileSync(path.join(src, "commands", f), "utf8"));
    write(
      path.join(out, "commands", f),
      stringifyFront({ description: data.description }, body)
    );
    n++;
  }

  // Управляемый блок в CLAUDE.md
  const roles = activeRoles(root, cfg);
  const byGroup = {};
  for (const r of roles) (byGroup[r.data.group || "прочее"] ||= []).push(r.name);
  const table = Object.entries(byGroup)
    .map(([g, list]) => `| ${g} | ${list.map((x) => "`" + x + "`").join(" · ")} |`)
    .join("\n");

  const block = `## Команда ИИ-агентов

> Развёрнуто через [agentkit](https://github.com/s1rne/agentkit). Файлы в \`.claude/\` **генерируются** — правь \`.agentkit/\`, затем \`npx agent-kit sync\`.

**Главная сессия — технический лид.** Не пишет продуктовый код: считает наряд, меняет штат, следит за ходом, докладывает человеку только развилки и результаты. Навыки \`tech-lead\`, \`team-composition\`, \`parallel-work\`.

| | |
|---|---|
${table}

### Интерфейс человека — читать первым

| Файл | Кто пишет | Что там |
|---|---|---|
| \`.agentkit/PROJECT.md\` | человек | что за проект, для кого, ограничения, словарь терминов |
| \`.agentkit/HOUSE-RULES.md\` | человек | **как работать**: инструменты, процесс, границы, состав команды. Лид перестраивает систему под эти правила сам — навык \`house-rules\` |
| \`.agentkit/INBOX.md\` | человек | мысли и пожелания в свободной форме; лид разбирает в задачи |
| \`.agentkit/QUESTIONS.md\` | оба | вопросы команды человеку и его ответы |

### Память проекта

| Файл | Что там |
|---|---|
| \`.agentkit/state/NOW.md\` | где мы сейчас — обязан быть точным всегда |
| \`.agentkit/state/JOURNAL.md\` | хронология: сделано / узнали / ошиблись |
| \`.agentkit/state/DECISIONS.md\` | принятые решения — не пересматривать молча |
| \`.agentkit/state/TEAM.md\` | штат команды: роли, потолки, ревьюеры |
| \`.agentkit/state/RUNS.md\` | журнал запусков агентов |
| \`tasks/BOARD.md\` | доска задач |

**Холодный старт с нулевым контекстом:** \`/boot\` или \`.agentkit/state/BOOT.md\`.

Команды: \`/boot\` · \`/plan\` · \`/task\` · \`/team\` · \`/roster\` · \`/review\` · \`/wrap\` · \`/standup\`

**Правила, которые не обсуждаются:** \`critic\` обязателен перед \`done\`; доменные тесты пишет \`qa-engineer\`, а не автор кода; задача с \`risk: high\` уходит человеку; сессия заканчивается \`/wrap\`; **работа не помечается как сделанная ИИ** — ни соавторства в коммитах, ни подписей в файлах, ни метаданных (навык \`no-ai-attribution\`).`;

  const st = upsertBlock(path.join(root, "CLAUDE.md"), block);
  ok(`Claude Code: ${n} файлов, CLAUDE.md ${st}`);
}
