import fs from "node:fs";
import path from "node:path";

export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

export const log = (...a) => console.log(...a);
export const ok = (m) => log(c.g("  ✓"), m);
export const warn = (m) => log(c.y("  !"), m);
export const err = (m) => log(c.r("  ✗"), m);

export function readDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function copyIfAbsent(src, dest) {
  if (fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/** Минимальный разбор frontmatter: key: value, key: [a, b]. Без зависимостей. */
export function parseFront(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
    } else if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, "");
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

export function stringifyFront(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

const START = "<!-- agentkit:start -->";
const END = "<!-- agentkit:end -->";

/** Вписать управляемый блок в чужой файл, не тронув остальное. */
export function upsertBlock(file, block) {
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  if (!fs.existsSync(file)) {
    write(file, wrapped + "\n");
    return "создан";
  }
  const cur = fs.readFileSync(file, "utf8");
  if (cur.includes(START) && cur.includes(END)) {
    const next = cur.replace(new RegExp(`${START}[\\s\\S]*?${END}`), wrapped);
    if (next === cur) return "без изменений";
    write(file, next);
    return "обновлён";
  }
  write(file, wrapped + "\n\n" + cur);
  return "блок добавлен";
}

export function loadConfig(root) {
  const f = path.join(root, ".agentkit", "config.json");
  if (!fs.existsSync(f)) {
    err("Не найден .agentkit/config.json. Сначала: npx agentkit init");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function activeRoles(root, cfg) {
  const dir = path.join(root, ".agentkit", "roles");
  return readDir(dir)
    .map((f) => {
      const { data, body } = parseFront(fs.readFileSync(path.join(dir, f), "utf8"));
      const name = data.name || f.replace(/\.md$/, "");
      return { name, data, body, cfg: cfg.roles?.[name] ?? {} };
    })
    .filter((r) => r.cfg.enabled !== false);
}
