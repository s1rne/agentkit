import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const GB = 1024 * 1024 * 1024;

/**
 * Внутри контейнера машина — не та, что показывает ядро.
 *
 * `os.freemem()` и `os.cpus()` рассказывают про хост, а процесс живёт в cgroup
 * с собственным пределом. Контейнер на 4 ГБ на машине с 64 ГБ насчитывал места
 * на восьмерых агентов при потребности в 2,5 ГБ каждому — впятеро больше, чем
 * влезает. Дальше OOM-killer убивал их по одному, и снаружи это выглядело не
 * как нехватка памяти, а как случайно обрывающиеся прогоны. Промах был при этом
 * молчаливым: `doctor` смотрел туда же и показывал здоровую картину.
 *
 * Путь берётся из окружения, чтобы предел можно было прочитать и там, где
 * иерархия смонтирована не по канону — и чтобы это было проверяемо тестом.
 */
const cgroupRoot = () => process.env.AGENTKIT_CGROUP_ROOT || "/sys/fs/cgroup";

function readCgroup(...rel) {
  try {
    return fs.readFileSync(path.join(cgroupRoot(), ...rel), "utf8").trim();
  } catch {
    return "";
  }
}

// Anything that is not a plain number is "no answer": an empty file, a missing
// one, and v2's literal "max" all mean there is no limit to read here.
const num = (text) => (/^\d+$/.test(text) ? Number(text) : null);

/**
 * Предел памяти той cgroup, в которой мы работаем, и сколько из него занято.
 * null — предела нет, значит машина и есть машина.
 */
function cgroupMemory() {
  const total = os.totalmem();
  // v2: memory.max — либо число, либо "max"
  const v2 = num(readCgroup("memory.max"));
  const used2 = num(readCgroup("memory.current"));
  const limit = v2 !== null && used2 !== null ? { limit: v2, used: used2, stat: readCgroup("memory.stat") }
    // v1: без предела здесь лежит сторожевое число размером с адресное пространство
    : (() => {
        const v1 = num(readCgroup("memory", "memory.limit_in_bytes"));
        const used1 = num(readCgroup("memory", "memory.usage_in_bytes"));
        return v1 !== null && used1 !== null ? { limit: v1, used: used1, stat: readCgroup("memory", "memory.stat") } : null;
      })();
  if (!limit || limit.limit <= 0 || limit.limit >= total) return null;

  // Страничный кэш числится занятым, но отдаётся под давлением: без этой поправки
  // контейнер после сборки выглядел бы забитым под потолок и не брал бы работу.
  const cache = Number(limit.stat.match(/^inactive_file (\d+)$/m)?.[1]) || 0;
  const avail = Math.max(0, limit.limit - Math.max(0, limit.used - cache));
  return { limit: limit.limit, avail };
}

/** Сколько процессорного времени cgroup реально даст, в целых ядрах. null — без квоты. */
function cgroupCpus() {
  const v2 = readCgroup("cpu.max").split(/\s+/);
  if (v2.length === 2 && v2[0] !== "max") {
    const quota = num(v2[0]);
    const period = num(v2[1]);
    if (quota && period) return quota / period;
  }
  const quota = num(readCgroup("cpu", "cpu.cfs_quota_us"));
  const period = num(readCgroup("cpu", "cpu.cfs_period_us"));
  if (quota && period) return quota / period;
  return null;
}

/** Run a probe command. Any failure (missing binary, timeout, non-zero) means "unknown". */
function probe(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Memory macOS will actually hand to a new process.
 * os.freemem() only counts free pages there, and macOS keeps almost everything
 * as cache — so it reads near zero on a perfectly idle machine.
 */
function availRamBytes() {
  const out = probe("vm_stat", []);
  if (!out) return os.freemem();
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096;
  const pages = (name) => Number(out.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m"))?.[1]) || 0;
  const usable = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return usable > 0 ? usable * pageSize : os.freemem();
}

/** Performance cores only — efficiency cores run an agent, but slowly enough to skew the plan. */
function perfCoreCount(cores) {
  const out = probe("sysctl", ["-n", "hw.perflevel0.logicalcpu"]);
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : cores;
}

function diskFreeBytes(root) {
  // -P forces one line per filesystem, so the columns are safe to index.
  const out = probe("df", ["-kP", root]);
  const line = out.trim().split(/\n/).pop() || "";
  const kb = Number(line.trim().split(/\s+/)[3]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

export function capacity(root = process.cwd()) {
  const cores = os.cpus()?.length || 1;
  const load1 = os.loadavg()[0] || 0;
  const mem = cgroupMemory();
  const cpus = cgroupCpus();
  // Ядра для плана — те, что нам действительно отдадут. Нагрузка при этом
  // по-прежнему считается на все ядра машины: loadavg внутри контейнера
  // приходит от хоста, и делить хостовую нагрузку на квоту значит выдумать
  // перегрузку на ровном месте.
  const usable = cpus ? Math.max(1, Math.floor(cpus)) : perfCoreCount(cores);
  return {
    cores,
    perfCores: Math.min(perfCoreCount(cores), usable),
    ramTotalGB: round((mem ? mem.limit : os.totalmem()) / GB),
    ramAvailGB: round((mem ? mem.avail : availRamBytes()) / GB),
    diskFreeGB: round(diskFreeBytes(root) / GB),
    load1: round(load1),
    loadPerCore: round(load1 / cores),
    /**
     * Память принадлежит нам одним: предел пришёл от cgroup, а не от машины, —
     * значит редактора и браузера человека на ней нет и резервировать под них
     * нечего. Резерв для машины человека в контейнере означал бы «не запускать
     * никогда»: под четырёхгигабайтным пределом шесть гигабайт не оставить.
     */
    dedicated: Boolean(mem),
  };
}

export const DEFAULT_LIMITS = {
  // Measured on real runs, not on an idle process. A task that only edits files
  // sits near 1.4 GB; one that installs dependencies and runs a build peaked at
  // 4.5 GB. Admission assumes the heavier case, because admitting on the lighter
  // one and then meeting the heavier one is how a machine gets wedged.
  agentRssMB: 6000, // hard per-agent ceiling before the watchdog kills it
  estAgentRssMB: 2500, // what we assume one agent needs when deciding to admit
  reserveRamGB: 6, // RAM left untouched for the human's editor and browser
  reserveDiskGB: 20, // disk left untouched
  reserveRamGBDedicated: 1, // RAM left untouched when nobody shares it — a cgroup limit
  maxAgentMinutes: 20,
  maxConcurrent: null, // a human ceiling; null means "whatever the machine allows" // per-agent wall clock
  loadPerCoreMax: 1.5, // refuse new work above this
};

/** Absolute ceiling: past this the provider is the bottleneck, not the machine. */
const HARD_CEILING = 8;

/** What to leave untouched: the human's editor and browser, unless there is no human here. */
const reserveOf = (l, cap) => (cap.dedicated ? Math.min(l.reserveRamGB, l.reserveRamGBDedicated) : l.reserveRamGB);

export function maxConcurrency(limits = DEFAULT_LIMITS, cap = capacity()) {
  // A human-set ceiling wins over anything the machine would allow.
  const l = { ...DEFAULT_LIMITS, ...limits };
  const byRam = Math.floor(((cap.ramAvailGB - reserveOf(l, cap)) * 1024) / l.estAgentRssMB);
  const byCpu = cap.perfCores - 2; // headroom for the human and the orchestrator
  const byHuman = Number.isFinite(l.maxConcurrent) && l.maxConcurrent > 0 ? l.maxConcurrent : Infinity;
  return Math.max(1, Math.min(byRam, byCpu, HARD_CEILING, byHuman));
}

/**
 * The real gate. maxConcurrency says how many fit in theory; this says whether
 * one more may start right now, and gives a reason a human can act on.
 */
/**
 * Место для запуска.
 *
 * `priority: true` даёт один зарезервированный слот сверх обычного потолка —
 * для работы, за которой стоит очередь: слияния, интеграции, разбора конфликта.
 * Пределы машины при этом не смягчаются: память, диск и нагрузка проверяются
 * так же. Приоритет двигает очередь, а не границу безопасности.
 */
export function admits(running = 0, limits = DEFAULT_LIMITS, cap = capacity(), { priority = false } = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  // Приоритетной работе — один слот сверх обычного потолка. Пределы машины ниже
  // при этом не смягчаются: приоритет двигает очередь, а не границу безопасности.
  const max = maxConcurrency(l, cap) + (priority ? 1 : 0);
  const reserve = reserveOf(l, cap);
  const headroomGB = cap.ramAvailGB - reserve;

  if (running >= max) {
    return { ok: false, reason: `Concurrency: ${running} agents running, limit is ${max}`, waitMs: 15000 };
  }
  if (headroomGB < l.estAgentRssMB / 1024) {
    return {
      ok: false,
      reason: `RAM: ${cap.ramAvailGB} GB available, ${reserve} GB reserved, one agent needs ~${l.estAgentRssMB} MB`,
      waitMs: 30000,
    };
  }
  if (cap.diskFreeGB < l.reserveDiskGB) {
    return {
      ok: false,
      reason: `Disk: ${cap.diskFreeGB} GB free, ${l.reserveDiskGB} GB reserved`,
      waitMs: 60000,
    };
  }
  if (cap.loadPerCore > l.loadPerCoreMax) {
    return {
      ok: false,
      reason: `Load: ${cap.loadPerCore} per core, ceiling is ${l.loadPerCoreMax}`,
      waitMs: 30000,
    };
  }
  return { ok: true };
}

/** pid -> RSS in KB, plus pid -> children, from a single ps call. */
function psSnapshot() {
  const out = probe("ps", ["axo", "pid,ppid,rss"]);
  const rss = new Map();
  const kids = new Map();
  for (const line of out.split(/\n/).slice(1)) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rss.set(pid, Number.isFinite(kb) ? kb : 0);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { rss, kids };
}

/** Total RSS in MB for a process and everything it spawned. 0 if it is gone. */
/**
 * Summed resident memory of a process and its descendants.
 *
 * This over-reports: pages shared between the processes are counted in each of
 * them. It is what `ps` can tell us cheaply, so the ceiling is a budget for the
 * tree as measured, not a claim about physical pages. The watchdog compensates
 * by requiring a sustained breach.
 */
export function processTreeRSS(pid) {
  const { rss, kids } = psSnapshot();
  if (!rss.has(pid)) return 0;
  let kb = 0;
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    kb += rss.get(p) || 0;
    for (const child of kids.get(p) || []) {
      if (seen.has(child)) continue; // cycles are impossible, reparenting races are not
      seen.add(child);
      queue.push(child);
    }
  }
  return round(kb / 1024, 1);
}

function killTree(pid, signal) {
  const { kids } = psSnapshot();
  const targets = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    targets.push(p);
    for (const child of kids.get(p) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  // Children first, so a parent cannot respawn them on the way down.
  for (const p of targets.reverse()) {
    try {
      process.kill(p, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Watchdog over a running agent: samples the whole process tree and kills it
 * if it outgrows its memory ceiling or outlives its wall clock.
 */
export function watch(pid, opts = {}) {
  const {
    maxRssMB = DEFAULT_LIMITS.agentRssMB,
    maxMs = DEFAULT_LIMITS.maxAgentMinutes * 60000,
    intervalMs = 5000,
    // A tree's RSS is a sum, and shared pages are counted once per process, so
    // the figure runs above real usage — an agent running a test suite spikes
    // hardest. Killing on a single sample would end healthy work; a breach has
    // to persist to count.
    breachSamples = 2,
    onKill,
  } = opts;

  const started = Date.now();
  let peak = 0;
  let overCount = 0;
  let killTimer = null;
  let timer = null;

  // stop() must not cancel a pending SIGKILL: the direct child dies on SIGTERM in
  // milliseconds, and clearing the timer then leaves any descendant that ignored
  // SIGTERM — a dev server, a hung MCP process — running forever.
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const terminate = (reason) => {
    stop();
    killTree(pid, "SIGTERM");
    killTimer = setTimeout(() => killTree(pid, "SIGKILL"), 5000);
    killTimer.unref?.();
    if (typeof onKill === "function") onKill(reason);
  };

  timer = setInterval(() => {
    const rss = processTreeRSS(pid);
    if (rss === 0) return stop(); // process finished on its own
    if (rss > peak) peak = rss;
    if (rss > maxRssMB) {
      if (++overCount >= breachSamples) {
        return terminate(
          `Agent ${pid} held ${rss} MB RSS across its process tree for ${overCount} samples, ceiling is ${maxRssMB} MB`
        );
      }
    } else overCount = 0;
    const min = Math.round((Date.now() - started) / 60000);
    if (Date.now() - started > maxMs) return terminate(`Agent ${pid} ran ${min} min, ceiling is ${Math.round(maxMs / 60000)} min`);
  }, intervalMs);
  timer.unref?.(); // a watchdog must never be the reason the process stays alive

  return { stop, peakRssMB: () => peak };
}
