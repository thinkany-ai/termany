/**
 * Machine-level CPU / memory sampling for the activity monitor pane.
 *
 * Everything here shells out to tools already present on the platform (`ps`,
 * `vm_stat`, `sysctl`) instead of pulling in a native dependency — the numbers
 * only need to be good enough to answer "what's making the fan spin".
 */
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** One live process inside a group — what the table shows when you expand a row. */
export interface ProcessInstance {
  pid: number;
  /** Percent of one core. */
  cpu: number;
  memBytes: number;
  user: string;
  /** TCP ports this pid is listening on, ascending. Empty for most processes. */
  ports: number[];
}

export interface ProcessGroup {
  /** Aggregated over every process sharing this name (see `count`). */
  name: string;
  /** Percent of one core, summed across instances — same scale as Activity Monitor. */
  cpu: number;
  memBytes: number;
  count: number;
  /** Representative pid (the biggest CPU consumer in the group). */
  pid: number;
  /** Owner of the representative process, or "" when the group spans users. */
  user: string;
  /** Union of every instance's listening ports, ascending. */
  ports: number[];
  /** Every instance, biggest CPU first. Length always matches `count`. */
  children: ProcessInstance[];
}

export interface MemoryStats {
  total: number;
  used: number;
  /** macOS/Linux breakdown, omitted where the platform can't report it. */
  active?: number;
  wired?: number;
  compressed?: number;
  cached?: number;
  swapUsed?: number;
  swapTotal?: number;
  /** Heuristic — see `memoryPressure`. Not the kernel's own pressure metric. */
  pressure: "normal" | "warning" | "critical";
}

/** One point on the footer sparkline. */
export interface Sample {
  t: number;
  cpu: number;
  memUsed: number;
}

export interface SystemStats {
  cpu: {
    /** Whole-machine utilization, 0–100. */
    usage: number;
    /** Split of `usage` into user vs system time over the same delta. */
    user: number;
    system: number;
    cores: number;
    loadavg: [number, number, number];
  };
  memory: MemoryStats;
  processes: ProcessGroup[];
  /** Oldest first. Sampled per request, so it tracks whoever is polling. */
  history: Sample[];
  uptimeSec: number;
}

// The footer chart shows a few minutes of context. Samples older than this are
// dropped on read so a pane reopened after a long gap doesn't draw a flat line
// across the hole and pass it off as history.
const HISTORY_MAX_AGE_MS = 5 * 60 * 1000;
const HISTORY_CAP = 240;

const history: Sample[] = [];

// os.cpus() reports cumulative counters, so utilization is the delta between
// two samples. The poll interval supplies that gap; the first call after a
// cold start takes its own short sample instead.
let prev: { idle: number; user: number; system: number; total: number } | null = null;

function cpuTimes() {
  let idle = 0;
  let user = 0;
  let system = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
      else if (kind === "user" || kind === "nice") user += ms;
      else system += ms;
    }
  }
  return { idle, user, system, total };
}

async function cpuUsage(): Promise<{ usage: number; user: number; system: number }> {
  if (!prev) {
    prev = cpuTimes();
    await new Promise((r) => setTimeout(r, 150));
  }
  const now = cpuTimes();
  const totalDelta = now.total - prev.total;
  const idleDelta = now.idle - prev.idle;
  const userDelta = now.user - prev.user;
  const systemDelta = now.system - prev.system;
  prev = now;
  if (totalDelta <= 0) return { usage: 0, user: 0, system: 0 };
  const pct = (n: number) => Math.min(100, Math.max(0, (n / totalDelta) * 100));
  return {
    usage: pct(totalDelta - idleDelta),
    user: pct(userDelta),
    system: pct(systemDelta),
  };
}

/**
 * A stand-in for Activity Monitor's green/yellow/red pressure gauge. The real
 * metric comes from the kernel's memorystatus subsystem, which we can't read
 * without a native module — this approximates it from how much of the machine
 * is committed and how hard the compressor and swap are working, which moves
 * in the same direction for the same reasons.
 */
function memoryPressure(m: {
  total: number;
  used: number;
  compressed?: number;
  swapUsed?: number;
  swapTotal?: number;
}): MemoryStats["pressure"] {
  const committed = m.total > 0 ? m.used / m.total : 0;
  const compressed = m.compressed && m.total > 0 ? m.compressed / m.total : 0;
  const swapped = m.swapUsed && m.swapTotal ? m.swapUsed / m.swapTotal : 0;
  if (committed > 0.92 || compressed > 0.3 || swapped > 0.75) return "critical";
  if (committed > 0.75 || compressed > 0.15 || swapped > 0.35) return "warning";
  return "normal";
}

async function swapUsage(): Promise<{ swapUsed?: number; swapTotal?: number }> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execAsync("sysctl -n vm.swapusage");
      // "total = 30720.00M  used = 29688.25M  free = 1031.75M"
      const mb = (label: string) =>
        Math.round(Number(new RegExp(`${label} = ([\\d.]+)M`).exec(stdout)?.[1] ?? NaN) * 1024 ** 2);
      const total = mb("total");
      const used = mb("used");
      if (Number.isFinite(total) && Number.isFinite(used)) return { swapTotal: total, swapUsed: used };
    } catch {
      /* no swap info — pressure falls back to the committed ratio alone */
    }
  }
  if (process.platform === "linux") {
    try {
      const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
      const kb = (label: string) =>
        Number(new RegExp(`${label}:\\s+(\\d+) kB`).exec(meminfo)?.[1] ?? NaN) * 1024;
      const total = kb("SwapTotal");
      const free = kb("SwapFree");
      if (Number.isFinite(total) && Number.isFinite(free)) {
        return { swapTotal: total, swapUsed: Math.max(0, total - free) };
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * "Memory used" the way Activity Monitor means it. os.freemem() on macOS
 * counts only the free list, so total-free reads as ~100% used on any machine
 * that has been up for a while — vm_stat's active/wired/compressed is the
 * number people actually recognize.
 */
async function memoryStats(total: number): Promise<MemoryStats> {
  const swap = await swapUsage();

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execAsync("vm_stat");
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
      const pages = (label: string) =>
        Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0) * pageSize;
      const active = pages("Pages active");
      const wired = pages("Pages wired down");
      const compressed = pages("Pages occupied by compressor");
      const cached = pages("File-backed pages");
      const used = active + wired + compressed;
      if (used > 0) {
        const m = { total, used: Math.min(total, used), active, wired, compressed, cached, ...swap };
        return { ...m, pressure: memoryPressure(m) };
      }
    } catch {
      /* fall through to the portable estimate */
    }
  }

  if (process.platform === "linux") {
    try {
      const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
      const kb = (label: string) =>
        Number(new RegExp(`${label}:\\s+(\\d+) kB`).exec(meminfo)?.[1] ?? 0) * 1024;
      const available = kb("MemAvailable");
      if (available > 0) {
        const m = {
          total,
          used: Math.max(0, total - available),
          active: kb("Active"),
          cached: kb("Cached"),
          ...swap,
        };
        return { ...m, pressure: memoryPressure(m) };
      }
    } catch {
      /* fall through */
    }
  }

  const m = { total, used: Math.max(0, total - os.freemem()), ...swap };
  return { ...m, pressure: memoryPressure(m) };
}

/**
 * pid → TCP ports it is listening on.
 *
 * "Who has port 3000?" is the question a terminal's monitor gets asked most,
 * so this rides along with every sample (`lsof` for listeners costs ~50ms).
 * A pid shows up once per bound address — IPv4 and IPv6 on the same port are
 * two rows — hence the dedupe.
 *
 * Best-effort: on a machine without `lsof` the column is simply empty rather
 * than the whole sample failing.
 */
async function listeningPorts(): Promise<Map<number, number[]>> {
  if (process.platform === "win32") return windowsListeningPorts();
  const byPid = new Map<number, Set<number>>();
  if (process.platform !== "darwin" && process.platform !== "linux") return new Map();
  let stdout: string;
  try {
    ({ stdout } = await execAsync("lsof -nP -iTCP -sTCP:LISTEN", { maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    return new Map();
  }

  for (const line of stdout.split("\n")) {
    // "node  92310 benn  23u  IPv6 0x…  0t0  TCP *:3000 (LISTEN)"
    const pid = Number(/^\S+\s+(\d+)\s/.exec(line)?.[1]);
    // The address is the last field before (LISTEN): *:3000, 127.0.0.1:5432,
    // [::1]:8080 — take whatever follows the final colon.
    const port = Number(/\s(\S+):(\d+)\s+\(LISTEN\)/.exec(line)?.[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    const hit = byPid.get(pid);
    if (hit) hit.add(port);
    else byPid.set(pid, new Set([port]));
  }

  return new Map([...byPid].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b)]));
}

/**
 * The Windows counterpart of the `lsof` parse: `netstat` ships with every
 * install and `-a -n -o -p tcp` prints one "proto local foreign state pid"
 * row per socket — the same shape, columns in a different order.
 */
async function windowsListeningPorts(): Promise<Map<number, number[]>> {
  const byPid = new Map<number, Set<number>>();
  let stdout: string;
  try {
    ({ stdout } = await execAsync("netstat -ano -p tcp", { maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    return new Map();
  }

  for (const line of stdout.split("\n")) {
    // "  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    1234"
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const port = Number(cols[1].slice(cols[1].lastIndexOf(":") + 1));
    const pid = Number(cols[4]);
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    const hit = byPid.get(pid);
    if (hit) hit.add(port);
    else byPid.set(pid, new Set([port]));
  }

  return new Map([...byPid].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b)]));
}

/**
 * Every process, grouped by executable name — a browser with 40 helper
 * processes should read as one heavy app, not flood the whole list. The full
 * set is returned rather than a top-N slice: the pane sorts and searches
 * client-side, and a truncated list would quietly hide whatever the user is
 * searching for.
 */
async function processGroups(): Promise<ProcessGroup[]> {
  const instances = await processInstances();
  if (!instances.length) return [];

  const byName = new Map<string, ProcessGroup>();
  for (const instance of instances) {
    const hit = byName.get(instance.name);
    if (hit) {
      hit.cpu += instance.cpu;
      hit.memBytes += instance.memBytes;
      hit.count++;
      hit.children.push(instance);
    } else {
      byName.set(instance.name, {
        name: instance.name,
        cpu: instance.cpu,
        memBytes: instance.memBytes,
        count: 1,
        pid: instance.pid,
        user: instance.user,
        ports: [],
        children: [instance],
      });
    }
  }

  for (const group of byName.values()) {
    group.children.sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes);
    // The representative row stands in for the group when collapsed, so point
    // it at the instance actually burning the CPU.
    group.pid = group.children[0].pid;
    group.user = group.children.every((c) => c.user === group.children[0].user)
      ? group.children[0].user
      : "";
    group.ports = [...new Set(group.children.flatMap((c) => c.ports))].sort((a, b) => a - b);
  }

  return [...byName.values()].sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes);
}

interface NamedProcessInstance extends ProcessInstance {
  name: string;
}

async function processInstances(): Promise<NamedProcessInstance[]> {
  if (process.platform === "win32") return windowsProcessInstances();
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let stdout: string;
  let ports: Map<number, number[]>;
  try {
    [{ stdout }, ports] = await Promise.all([
      execAsync("ps -Ao pid=,pcpu=,rss=,user=,comm=", { maxBuffer: 16 * 1024 * 1024 }),
      listeningPorts(),
    ]);
  } catch {
    return []; // ps missing or sandboxed away — the footer stats still work
  }

  const instances: NamedProcessInstance[] = [];
  for (const line of stdout.split("\n")) {
    // comm can contain spaces (".../OrbStack Helper"), so only split the
    // four fixed-width columns off the front and keep the rest verbatim.
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidStr, cpuStr, rssStr, user, comm] = m;
    const name = path.basename(comm.trim()) || comm.trim();
    if (!name) continue;
    const pid = Number(pidStr);
    instances.push({
      name,
      pid,
      cpu: Number(cpuStr),
      memBytes: Number(rssStr) * 1024,
      user,
      ports: ports.get(pid) ?? [],
    });
  }
  return instances;
}

// Get-Process reports cumulative CPU seconds, so a process's percentage is
// the delta between two polls — the same trick the whole-machine counters in
// cpuUsage() use. The first poll after a cold start reports 0 rather than a
// fake spike.
let prevWinProc: { t: number; cpuSec: Map<number, number> } | null = null;

/**
 * The Windows counterpart of the `ps` parse. PowerShell's Get-Process is the
 * only no-dependency source that has both working set and CPU time (tasklist
 * has no CPU counter); per-process CPU% is derived from the CPU-seconds delta
 * between polls, percent of one core like the Unix side.
 *
 * The owning user is left empty: resolving it needs a per-process CIM owner
 * lookup that costs far more than the whole rest of the sample, and the table
 * already renders "" as "—".
 */
async function windowsProcessInstances(): Promise<NamedProcessInstance[]> {
  let stdout: string;
  let ports: Map<number, number[]>;
  try {
    [{ stdout }, ports] = await Promise.all([
      execAsync(
        'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress"',
        { maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
      ),
      windowsListeningPorts(),
    ]);
  } catch {
    return []; // powershell missing or too slow — the footer stats still work
  }

  let raw: { Id?: number; ProcessName?: string; WorkingSet64?: number; CPU?: number | null }[];
  try {
    const parsed: unknown = JSON.parse(stdout);
    // ConvertTo-Json drops the array wrapper when the list has one element.
    raw = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  const now = Date.now();
  const prevSample = prevWinProc;
  const wallSec = prevSample ? (now - prevSample.t) / 1000 : 0;
  const cpuSec = new Map<number, number>();

  const instances: NamedProcessInstance[] = [];
  for (const p of raw) {
    const pid = Number(p?.Id);
    const name = String(p?.ProcessName ?? "").trim();
    if (!Number.isInteger(pid) || pid <= 0 || !name) continue;
    const totalCpuSec = Number(p?.CPU) || 0;
    cpuSec.set(pid, totalCpuSec);
    const prevSec = prevSample?.cpuSec.get(pid);
    const cpu =
      prevSec !== undefined && wallSec > 0 ? Math.max(0, ((totalCpuSec - prevSec) / wallSec) * 100) : 0;
    instances.push({
      name,
      pid,
      cpu,
      memBytes: Number(p?.WorkingSet64) || 0,
      user: "",
      ports: ports.get(pid) ?? [],
    });
  }
  prevWinProc = { t: now, cpuSec };
  return instances;
}

export async function readSystemStats(): Promise<SystemStats> {
  const total = os.totalmem();
  const [cpu, memory, processes] = await Promise.all([
    cpuUsage(),
    memoryStats(total),
    processGroups(),
  ]);
  const [l1, l5, l15] = os.loadavg();

  const now = Date.now();
  history.push({ t: now, cpu: cpu.usage, memUsed: memory.used });
  const cutoff = now - HISTORY_MAX_AGE_MS;
  while (history.length && (history[0].t < cutoff || history.length > HISTORY_CAP)) history.shift();

  return {
    cpu: { ...cpu, cores: os.cpus().length, loadavg: [l1, l5, l15] },
    memory,
    processes,
    history: [...history],
    uptimeSec: os.uptime(),
  };
}

export class KillError extends Error {}

/**
 * Send a signal to a process on behalf of the monitor's "quit process" button.
 *
 * Deliberately narrow: only TERM and KILL, never pid <= 1, and never this
 * server itself — killing the process that serves the UI would take every
 * shell in the app down with it, which is never what the button meant.
 */
export function killProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!Number.isInteger(pid) || pid <= 1) throw new KillError(`refusing to signal pid ${pid}`);
  if (pid === process.pid) throw new KillError("refusing to kill the termany server");
  if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new KillError(`bad signal ${signal}`);
  try {
    process.kill(pid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") throw new KillError("process is already gone");
    if (code === "EPERM") throw new KillError("not permitted — the process belongs to another user");
    throw e;
  }
}
