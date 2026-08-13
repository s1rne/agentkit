/**
 * CLI messages. Templates are chosen by `--lang`; so is this.
 * Keys are shared; a missing key falls back to English.
 */

const en = {
  // init
  initHeader: "agentkit init",
  initMeta: (pack, adapters, lang) => `· pack ${pack} · ${adapters} · lang ${lang}`,
  existsAlready: ".agentkit already exists. To refresh generated configs: npx @s1rne/agentkit sync. To reinstall: --force",
  noPack: (name, list) => `No pack "${name}". Available: ${list}`,
  noLang: (name, list) => `No language "${name}". Available: ${list}`,
  coreCopied: "core copied to .agentkit/",
  memoryCreated: "memory created: .agentkit/state/",
  memoryKept: (n) => `memory created (${n} files already existed — kept)`,
  humanIface: "human interface: PROJECT.md · HOUSE-RULES.md · INBOX.md · QUESTIONS.md",
  tasksAdr: "tasks: tasks/  ·  ADR: docs/adr/",
  configWritten: "config: .agentkit/config.json",
  notInPack: (pack) => `not in pack ${pack}`,
  done: "Done.",
  nextSteps: "Next — fill in three files, the system handles the rest:",
  step1: ".agentkit/PROJECT.md      what the project is, for whom, glossary",
  step2: ".agentkit/HOUSE-RULES.md  how to work: tools, process, boundaries",
  step3: ".agentkit/state/NOW.md    where you are now",
  thenBoot: (cmd) => `Then, in a fresh session: ${cmd}`,

  // sync
  syncHeader: "agentkit sync",
  unknownAdapter: (a) => `unknown adapter "${a}" — skipped`,

  // doctor
  doctorHeader: "agentkit doctor",
  memoryFile: (f) => `memory: ${f}`,
  memoryMissing: (f) => `missing .agentkit/state/${f}`,
  humanFile: (f) => `human interface: ${f}`,
  humanMissing: (f) => `missing .agentkit/${f}`,
  projectEmpty: "PROJECT.md is not filled in — the team works blind",
  roleMissing: (name) => `role "${name}" is in the config but .agentkit/roles/${name}.md is missing`,
  skillMissing: (role, skill) => `role "${role}" references a skill that does not exist: "${skill}"`,
  nowEmpty: "NOW.md is not filled in — a cold start will find nothing",
  staleGenerated: "sources in .agentkit/ are newer than generated files — run: npx @s1rne/agentkit sync",
  problems: (n) => `${n} problem${n === 1 ? "" : "s"}`,
  noProblems: "No problems.",
  activeRoles: (n) => `  Active roles: ${n}`,

  // status
  project: "project",
  statusMeta: (pack, adapters) => `· pack ${pack} · ${adapters}`,
  capUpTo: (n) => `up to ${n}`,
  disabled: (list) => `disabled: ${list}`,
  nowLabel: "now: ",

  // role
  roleNameRequired: "a role name is required",
  roleEnabled: (n) => `${n} enabled`,
  roleDisabled: (n) => `${n} disabled`,
  roleCap: (n, v) => `${n}: cap ${v}`,
  roleUsage: "role enable|disable|cap <name> [n]",
  rememberSync: "remember to run: npx @s1rne/agentkit sync",

  // adapters
  blockCreated: "created",
  blockUpdated: "updated",
  blockUnchanged: "unchanged",
  blockPrepended: "block added",
  claudeDone: (n, st) => `Claude Code: ${n} files, CLAUDE.md ${st}`,
  cursorDone: (n) => `Cursor: ${n} rules in .cursor/rules/`,
  agentsMdDone: (st) => `AGENTS.md ${st}`,

  // misc
  configMissing: "No .agentkit/config.json found. Run first: npx @s1rne/agentkit init",

  help: (b) => `
  ${b("agentkit")} — an AI agent team, project memory and process, in any repo

  ${b("npx @s1rne/agentkit init")} [--lang en|ru] [--pack base|web-product|full] [--adapters claude-code,cursor,agents-md] [--force]
  ${b("npx @s1rne/agentkit sync")}      regenerate tool configs from .agentkit/
  ${b("npx @s1rne/agentkit doctor")}    check integrity
  ${b("npx @s1rne/agentkit status")}    roster and current state
  ${b("npx @s1rne/agentkit role")} enable|disable|cap <role> [n]

  Edit ${b(".agentkit/")}, not the generated .claude/ and .cursor/ — sync overwrites those.
`,
};

const ru = {
  initHeader: "agentkit init",
  initMeta: (pack, adapters, lang) => `· пак ${pack} · ${adapters} · язык ${lang}`,
  existsAlready: ".agentkit уже существует. Обновить конфиги: npx @s1rne/agentkit sync. Переустановить: --force",
  noPack: (name, list) => `Нет пака «${name}». Доступны: ${list}`,
  noLang: (name, list) => `Нет языка «${name}». Доступны: ${list}`,
  coreCopied: "ядро скопировано в .agentkit/",
  memoryCreated: "память создана: .agentkit/state/",
  memoryKept: (n) => `память создана (${n} файлов уже были — сохранены)`,
  humanIface: "интерфейс человека: PROJECT.md · HOUSE-RULES.md · INBOX.md · QUESTIONS.md",
  tasksAdr: "задачи: tasks/  ·  ADR: docs/adr/",
  configWritten: "конфиг: .agentkit/config.json",
  notInPack: (pack) => `не входит в пак ${pack}`,
  done: "Готово.",
  nextSteps: "Дальше — заполни три файла, остальное система сделает сама:",
  step1: ".agentkit/PROJECT.md      что за проект, для кого, словарь терминов",
  step2: ".agentkit/HOUSE-RULES.md  как работать: инструменты, процесс, границы",
  step3: ".agentkit/state/NOW.md    где вы сейчас",
  thenBoot: (cmd) => `Затем в новой сессии: ${cmd}`,

  syncHeader: "agentkit sync",
  unknownAdapter: (a) => `неизвестный адаптер «${a}» — пропущен`,

  doctorHeader: "agentkit doctor",
  memoryFile: (f) => `память: ${f}`,
  memoryMissing: (f) => `нет .agentkit/state/${f}`,
  humanFile: (f) => `интерфейс человека: ${f}`,
  humanMissing: (f) => `нет .agentkit/${f}`,
  projectEmpty: "PROJECT.md не заполнен — команда работает вслепую",
  roleMissing: (name) => `роль «${name}» в конфиге, но нет .agentkit/roles/${name}.md`,
  skillMissing: (role, skill) => `роль «${role}» ссылается на несуществующий навык «${skill}»`,
  nowEmpty: "NOW.md не заполнен — холодный старт даст пустоту",
  staleGenerated: "исходники .agentkit/ новее сгенерированного — выполни: npx @s1rne/agentkit sync",
  problems: (n) => `${n} проблем`,
  noProblems: "Проблем нет.",
  activeRoles: (n) => `  Ролей активно: ${n}`,

  project: "проект",
  statusMeta: (pack, adapters) => `· пак ${pack} · ${adapters}`,
  capUpTo: (n) => `экз. до ${n}`,
  disabled: (list) => `выключены: ${list}`,
  nowLabel: "сейчас: ",

  roleNameRequired: "нужно имя роли",
  roleEnabled: (n) => `${n} включена`,
  roleDisabled: (n) => `${n} выключена`,
  roleCap: (n, v) => `${n}: потолок ${v}`,
  roleUsage: "role enable|disable|cap <имя> [n]",
  rememberSync: "не забудь: npx @s1rne/agentkit sync",

  blockCreated: "создан",
  blockUpdated: "обновлён",
  blockUnchanged: "без изменений",
  blockPrepended: "блок добавлен",
  claudeDone: (n, st) => `Claude Code: ${n} файлов, CLAUDE.md ${st}`,
  cursorDone: (n) => `Cursor: ${n} правил в .cursor/rules/`,
  agentsMdDone: (st) => `AGENTS.md ${st}`,

  configMissing: "Не найден .agentkit/config.json. Сначала: npx @s1rne/agentkit init",

  help: (b) => `
  ${b("agentkit")} — команда ИИ-агентов, память и процессы разработки в любом проекте

  ${b("npx @s1rne/agentkit init")} [--lang en|ru] [--pack base|web-product|full] [--adapters claude-code,cursor,agents-md] [--force]
  ${b("npx @s1rne/agentkit sync")}      перегенерировать конфиги инструментов из .agentkit/
  ${b("npx @s1rne/agentkit doctor")}    проверить целостность
  ${b("npx @s1rne/agentkit status")}    штат команды и текущее состояние
  ${b("npx @s1rne/agentkit role")} enable|disable|cap <роль> [n]

  Правь ${b(".agentkit/")}, не сгенерированные .claude/ и .cursor/ — их затрёт sync.
`,
};

const DICTS = { en, ru };
export const LANGS = Object.keys(DICTS);

/** t.someKey — a string, or a function when the message takes arguments. */
export function messages(lang) {
  const dict = DICTS[lang] || en;
  return new Proxy(dict, { get: (d, k) => (k in d ? d[k] : en[k]) });
}
