import path from "node:path";
import { upsertBlock, activeRoles, ok } from "../util.mjs";

export const id = "agents-md";
export const label = "AGENTS.md (Codex и совместимые)";

export function generate(root, cfg) {
  const roles = activeRoles(root, cfg);
  const list = roles
    .map((r) => `- **${r.name}** — ${r.data.description}`)
    .join("\n");

  const block = `## Команда ИИ-агентов

Развёрнуто через agentkit. Правила процесса — в \`.agentkit/skills/\`, роли — в \`.agentkit/roles/\`.

### Роли

${list}

Субагентов здесь нет: чтобы работать в роли, прочитай \`.agentkit/roles/<роль>.md\` и следуй её правилам. Задачи идут последовательно.

### Интерфейс человека — читать первым

- \`.agentkit/PROJECT.md\` — что за проект, для кого, словарь терминов (пишет человек)
- \`.agentkit/HOUSE-RULES.md\` — **как работать**: инструменты, процесс, границы. Система подстраивается под эти правила сама
- \`.agentkit/INBOX.md\` — пожелания человека в свободной форме
- \`.agentkit/QUESTIONS.md\` — вопросы команды человеку и ответы

### Память проекта

- \`.agentkit/state/NOW.md\` — где мы сейчас
- \`.agentkit/state/JOURNAL.md\` — хронология: сделано / узнали / ошиблись
- \`.agentkit/state/DECISIONS.md\` — принятые решения, не пересматривать молча
- \`.agentkit/state/TEAM.md\` — штат команды
- \`tasks/BOARD.md\` — доска задач

Холодный старт с нулевым контекстом: \`.agentkit/state/BOOT.md\`.

### Правила, которые не обсуждаются

Ревью критиком обязательно перед закрытием задачи. Тесты на доменные расчёты пишет не автор кода. Задача с \`risk: high\` уходит человеку. Сессия заканчивается записью состояния в \`NOW.md\` и \`JOURNAL.md\`. **Работа не помечается как сделанная ИИ** — ни соавторства в коммитах, ни подписей в файлах, ни метаданных: см. \`.agentkit/skills/no-ai-attribution.md\`.`;

  const st = upsertBlock(path.join(root, "AGENTS.md"), block);
  ok(`AGENTS.md ${st}`);
}
