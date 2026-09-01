import { useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { ActivityIcon } from "./icons";

type Translate = ReturnType<typeof useI18n>["t"];

interface ProcessInstance {
  pid: number;
  cpu: number;
  memBytes: number;
  user: string;
  ports: number[];
}

interface ProcessGroup extends ProcessInstance {
  name: string;
  count: number;
  children: ProcessInstance[];
}

interface Sample {
  t: number;
  cpu: number;
  memUsed: number;
}

interface SystemStats {
  cpu: { usage: number; user: number; system: number; cores: number; loadavg: [number, number, number] };
  memory: {
    total: number;
    used: number;
    active?: number;
    wired?: number;
    compressed?: number;
    cached?: number;
    swapUsed?: number;
    swapTotal?: number;
    pressure: "normal" | "warning" | "critical";
  };
  processes: ProcessGroup[];
  history: Sample[];
  uptimeSec: number;
}

type SortKey = "name" | "cpu" | "mem";

/** What the detail dialog shows — either one instance or a group's aggregate. */
interface ProcessDetail {
  name: string;
  pid: number;
  cpu: number;
  memBytes: number;
  user: string;
  ports: number[];
  count?: number;
}

const POLL_MS = 2000;
// ~2 minutes of per-process history at POLL_MS while the detail dialog is open.
const DETAIL_HISTORY_CAP = 60;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 2 : 1)} GB`;
}

function formatUptime(sec: number, t: Translate): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t("monitor.uptime.d", { d, h });
  if (h > 0) return t("monitor.uptime.h", { h, m });
  return t("monitor.uptime.m", { m });
}

/**
 * The footer CPU chart. Drawn from the server's sample ring rather than one
 * kept here, so the line survives the pane being closed and reopened — and so
 * it shows a real gap (fewer points) instead of splicing across one.
 */
function Sparkline({ samples, max }: { samples: Sample[]; max: number }) {
  if (samples.length < 2) return <span className="sysmon-spark empty" />;
  const span = Math.max(1, samples.length - 1);
  const point = (s: Sample, i: number) =>
    `${(i / span) * 100},${100 - Math.min(100, (s.cpu / max) * 100)}`;
  const line = samples.map(point).join(" ");
  return (
    <svg className="sysmon-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,100 ${line} 100,100`} className="sysmon-spark-fill" />
      <polyline points={line} className="sysmon-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A per-process history line for the detail dialog, scaled to its own peak
 * (per-process CPU can top 100% across cores, and memory has no fixed ceiling).
 * The series accumulates only while the dialog is open — like Activity
 * Monitor's per-process graph, it draws in as you watch — so it opens showing
 * a single point and fills from there.
 */
function MiniChart({ values, variant }: { values: number[]; variant?: "mem" }) {
  if (values.length < 2) {
    return <div className={`sysmon-mini empty ${variant ?? ""}`}>{/* filling… */}</div>;
  }
  const max = Math.max(1, ...values);
  const span = Math.max(1, values.length - 1);
  const line = values.map((v, i) => `${(i / span) * 100},${100 - Math.min(100, (v / max) * 100)}`).join(" ");
  return (
    <svg className={`sysmon-mini ${variant ?? ""}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,100 ${line} 100,100`} className="sysmon-mini-fill" />
      <polyline points={line} className="sysmon-mini-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A process row — a collapsed group, an expanded group header, or a child. */
function ProcessRow({
  label,
  cpu,
  memBytes,
  user,
  ports,
  pid,
  count,
  child,
  expanded,
  cpuScale,
  memScale,
  onToggle,
  onOpenDetail,
}: {
  label: string;
  cpu: number;
  memBytes: number;
  user: string;
  ports: number[];
  pid: number;
  count?: number;
  child?: boolean;
  expanded?: boolean;
  cpuScale: number;
  memScale: number;
  onToggle?: () => void;
  onOpenDetail: () => void;
}) {
  return (
    <div className={`sysmon-row ${child ? "child" : ""}`} onDoubleClick={onOpenDetail}>
      {onToggle ? (
        <button
          className={`sysmon-twisty ${expanded ? "open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-expanded={expanded}
        >
          ▸
        </button>
      ) : (
        <span className="sysmon-twisty-spacer" />
      )}
      <span className="sysmon-pid">{pid}</span>
      <span className="sysmon-name">
        <span className="sysmon-name-text" title={label}>
          {label}
        </span>
        {count && count > 1 && <em className="sysmon-count">×{count}</em>}
      </span>
      <span className="sysmon-num">
        <i className="sysmon-cell-bar" style={{ width: `${Math.min(100, (cpu / cpuScale) * 100)}%` }} />
        <b>{cpu.toFixed(1)}%</b>
      </span>
      <span className="sysmon-num">
        <i
          className="sysmon-cell-bar mem"
          style={{ width: `${Math.min(100, (memBytes / memScale) * 100)}%` }}
        />
        <b>{formatBytes(memBytes)}</b>
      </span>
      <span className="sysmon-ports" title={ports.join(", ")}>
        {ports.slice(0, 3).map((p) => (
          <em key={p} className="sysmon-port">
            {p}
          </em>
        ))}
        {ports.length > 3 && <em className="sysmon-port more">+{ports.length - 3}</em>}
      </span>
      <span className="sysmon-user">{user || "—"}</span>
    </div>
  );
}

/**
 * Activity monitor pane: every process (grouped by executable name, expandable
 * to the individual pids), sortable and searchable, over a fixed footer that
 * carries whole-machine CPU history and memory pressure.
 *
 * Deliberately one screen with no tabs — CPU and memory are the two numbers
 * that explain a slow machine, and putting them behind tabs would mean you can
 * never see both while a build runs. Polls /api/system-stats while mounted.
 */
export function SystemMonitor() {
  const { t } = useI18n();
  const [stats, setStats] = useState<SystemStats | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpu", desc: true });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The process a double-clicked row opened — the detail dialog is where a
  // process is inspected and terminated, so the table itself carries no
  // selection state or action button. `detailId` is what stays fixed; the
  // shown values and the two history series are re-derived from each poll so
  // the dialog is live, and the series accumulate only while it's open.
  const [detailId, setDetailId] = useState<{ pid: number; name: string; group: boolean } | null>(null);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [detailHistory, setDetailHistory] = useState<{ cpu: number; mem: number }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Native web/office preview panes paint above the DOM and ignore z-index,
  // so one overlapping this centered dialog would swallow the buttons' clicks.
  const detailBackdropRef = useNativeOccluder<HTMLDivElement>("sysmon-process-detail", detail !== null);

  const openDetail = (d: ProcessDetail, group: boolean) => {
    setDetailId({ pid: d.pid, name: d.name, group });
    setDetail(d);
    setDetailHistory([{ cpu: d.cpu, mem: d.memBytes }]);
  };
  const closeDetail = () => {
    setDetailId(null);
    setDetail(null);
    setDetailHistory([]);
  };
  // Keep the last good sample on screen if one poll fails, so the numbers
  // don't blink out on a transient hiccup.
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number;

    const poll = async () => {
      try {
        const r = await fetch(apiPath("/api/system-stats"));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as SystemStats;
        if (!cancelled) {
          failures.current = 0;
          setStats(data);
        }
      } catch {
        if (!cancelled && ++failures.current >= 2) setStats((s) => (s ? s : null));
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // While the detail dialog is open, follow its process across polls: re-read
  // its live values and push another point onto the two history series. A group
  // is tracked by name (its membership shifts); a single process by pid, in the
  // top level or inside any group's children.
  useEffect(() => {
    if (!detailId || !stats) return;
    let cur: ProcessDetail | null = null;
    if (detailId.group) {
      const g = stats.processes.find((p) => p.name === detailId.name);
      if (g) cur = { name: g.name, pid: g.pid, cpu: g.cpu, memBytes: g.memBytes, user: g.user, ports: g.ports, count: g.count };
    } else {
      for (const p of stats.processes) {
        const inst = p.pid === detailId.pid ? p : p.children.find((c) => c.pid === detailId.pid);
        if (inst) {
          cur = { name: detailId.name, pid: inst.pid, cpu: inst.cpu, memBytes: inst.memBytes, user: inst.user, ports: inst.ports };
          break;
        }
      }
    }
    if (!cur) return; // process gone — freeze on the last sample rather than blank
    setDetail(cur);
    setDetailHistory((h) => [...h, { cpu: cur.cpu, mem: cur.memBytes }].slice(-DETAIL_HISTORY_CAP));
  }, [stats, detailId]);

  const query_ = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const q = query_;
    const hitsPid = (p: ProcessInstance) =>
      String(p.pid).includes(q) || p.ports.some((port) => String(port).startsWith(q));
    // Matching ports is the point of the search box as much as matching names:
    // typing "3000" should answer "who is holding this port" directly. When the
    // query matches on a pid or port rather than the name, the group's other
    // instances are noise — "node ×69" expanding to 69 rows buries the one
    // process actually holding the port — so children are filtered too.
    const list = (stats?.processes ?? [])
      .filter((p) => !q || p.name.toLowerCase().includes(q) || hitsPid(p))
      .map((p) => {
        if (!q || p.name.toLowerCase().includes(q)) return p;
        // Narrowing the children has to re-derive the totals with them: left
        // alone, the row would pin all 69 node processes' 1.69 GB on the single
        // pid that happens to hold the port being searched for.
        const children = p.children.filter(hitsPid);
        return {
          ...p,
          children,
          count: children.length,
          pid: children[0].pid,
          cpu: children.reduce((a, c) => a + c.cpu, 0),
          memBytes: children.reduce((a, c) => a + c.memBytes, 0),
          ports: [...new Set(children.flatMap((c) => c.ports))].sort((a, b) => a - b),
        };
      });
    const dir = sort.desc ? 1 : -1;
    return list.sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * -dir;
      if (sort.key === "mem") return (b.memBytes - a.memBytes) * dir;
      return (b.cpu - a.cpu) * dir;
    });
  }, [stats?.processes, query_, sort]);

  // One scale for the in-cell bars, so a row's bar means the same thing
  // whether or not the list is filtered.
  const cpuScale = Math.max(1, ...(stats?.processes ?? []).map((p) => p.cpu));
  const memScale = Math.max(1, ...(stats?.processes ?? []).map((p) => p.memBytes));
  const historyMax = Math.max(20, ...(stats?.history ?? []).map((s) => s.cpu));

  const kill = async (pid: number, force: boolean) => {
    closeDetail();
    try {
      const r = await fetch(apiPath("/api/system-stats/kill"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid, force }),
      });
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) throw new Error(body?.error || String(r.status));
      setNotice(null);
    } catch (e) {
      setNotice(t("monitor.killFailed", { reason: e instanceof Error ? e.message : String(e) }));
    }
  };

  const header = (key: SortKey, label: string) => (
    <button
      className={`sysmon-sort ${sort.key === key ? "active" : ""}`}
      onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }))}
    >
      {label}
      {sort.key === key && <span className="sysmon-caret">{sort.desc ? "▾" : "▴"}</span>}
    </button>
  );

  if (stats === undefined) return <div className="sysmon-empty">{t("monitor.loading")}</div>;
  if (stats === null) return <div className="sysmon-empty">{t("monitor.error")}</div>;

  const mem = stats.memory;
  const memPct = (mem.used / mem.total) * 100;

  return (
    <div className="sysmon">
      <div className="sysmon-toolbar">
        <input
          className="sysmon-search"
          placeholder={t("monitor.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="sysmon-toolbar-note">
          {t("monitor.meta", { cores: stats.cpu.cores, uptime: formatUptime(stats.uptimeSec, t) })}
        </span>
      </div>

      {notice && <div className="sysmon-notice">{notice}</div>}

      <div className="sysmon-table">
        <div className="sysmon-row head">
          <span className="sysmon-twisty-spacer" />
          <span className="sysmon-pid">{t("monitor.col.pid")}</span>
          <span className="sysmon-name">{header("name", t("monitor.col.process"))}</span>
          <span className="sysmon-num">{header("cpu", "CPU")}</span>
          <span className="sysmon-num">{header("mem", t("monitor.col.memory"))}</span>
          <span className="sysmon-ports">{t("monitor.col.ports")}</span>
          <span className="sysmon-user">{t("monitor.col.user")}</span>
        </div>
        <div className="sysmon-rows">
          {stats.processes.length === 0 ? (
            <div className="sysmon-empty">{t("monitor.unsupported")}</div>
          ) : rows.length === 0 ? (
            <div className="sysmon-empty">{t("monitor.noMatch")}</div>
          ) : (
            rows.map((p) => {
              // A search is already a request to see the specific process, so
              // groups open themselves rather than making you click a twisty to
              // reach the row you just searched for.
              const open = expanded.has(p.name) || (!!query_ && p.count > 1);
              return (
                <div key={p.name}>
                  <ProcessRow
                    label={p.name}
                    cpu={p.cpu}
                    memBytes={p.memBytes}
                    user={p.user}
                    ports={p.ports}
                    pid={p.pid}
                    count={p.count}
                    expanded={open}
                    cpuScale={cpuScale}
                    memScale={memScale}
                    onToggle={
                      p.count > 1
                        ? () =>
                            setExpanded((s) => {
                              const next = new Set(s);
                              next.has(p.name) ? next.delete(p.name) : next.add(p.name);
                              return next;
                            })
                        : undefined
                    }
                    onOpenDetail={() =>
                      openDetail(
                        {
                          name: p.name,
                          pid: p.pid,
                          cpu: p.cpu,
                          memBytes: p.memBytes,
                          user: p.user,
                          ports: p.ports,
                          count: p.count,
                        },
                        p.count > 1,
                      )
                    }
                  />
                  {open &&
                    p.children.map((c) => (
                      <ProcessRow
                        key={c.pid}
                        label={p.name}
                        cpu={c.cpu}
                        memBytes={c.memBytes}
                        user={c.user}
                        ports={c.ports}
                        pid={c.pid}
                        child
                        cpuScale={cpuScale}
                        memScale={memScale}
                        onOpenDetail={() =>
                          openDetail(
                            {
                              name: p.name,
                              pid: c.pid,
                              cpu: c.cpu,
                              memBytes: c.memBytes,
                              user: c.user,
                              ports: c.ports,
                            },
                            false,
                          )
                        }
                      />
                    ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="sysmon-footer">
        <div className="sysmon-foot-block">
          <div className="sysmon-foot-head">
            <span className="sysmon-foot-label">CPU</span>
            <span className="sysmon-foot-value">{stats.cpu.usage.toFixed(0)}%</span>
          </div>
          <Sparkline samples={stats.history} max={historyMax} />
          <div className="sysmon-foot-note">
            <span>
              <i className="sysmon-dot user" />
              {t("monitor.cpuUser", { pct: stats.cpu.user.toFixed(0) })}
            </span>
            <span>
              <i className="sysmon-dot system" />
              {t("monitor.cpuSystem", { pct: stats.cpu.system.toFixed(0) })}
            </span>
            <span>{t("monitor.load", { values: stats.cpu.loadavg.map((l) => l.toFixed(2)).join(" · ") })}</span>
          </div>
        </div>

        <div className="sysmon-foot-block">
          <div className="sysmon-foot-head">
            <span className="sysmon-foot-label">{t("monitor.memory")}</span>
            <span className="sysmon-foot-value">
              {t("monitor.memOf", { used: formatBytes(mem.used), total: formatBytes(mem.total) })}
            </span>
            <span className={`sysmon-pressure ${mem.pressure}`}>
              {t(`monitor.pressure.${mem.pressure}`)}
            </span>
          </div>
          <div className="sysmon-membar">
            <i style={{ width: `${memPct}%` }} className={mem.pressure} />
          </div>
          <div className="sysmon-foot-note">
            {mem.active !== undefined && <span>{t("monitor.memActive", { v: formatBytes(mem.active) })}</span>}
            {mem.wired !== undefined && <span>{t("monitor.memWired", { v: formatBytes(mem.wired) })}</span>}
            {mem.compressed !== undefined && (
              <span>{t("monitor.memCompressed", { v: formatBytes(mem.compressed) })}</span>
            )}
            {mem.swapUsed !== undefined && <span>{t("monitor.swap", { v: formatBytes(mem.swapUsed) })}</span>}
          </div>
        </div>
      </div>

      {detail && (
        <div className="ws-dialog-backdrop" ref={detailBackdropRef} onClick={closeDetail}>
          <div className="ws-dialog sysmon-detail" onClick={(e) => e.stopPropagation()}>
            <div className="sysmon-detail-head">
              <span className="sysmon-detail-icon" aria-hidden>
                <ActivityIcon />
              </span>
              <div className="sysmon-detail-title">
                <div className="sysmon-detail-name" title={detail.name}>
                  <span className="sysmon-detail-name-text">{detail.name}</span>
                  {detail.count && detail.count > 1 && (
                    <em className="sysmon-count">×{detail.count}</em>
                  )}
                </div>
                <div className="sysmon-detail-sub">
                  {t("monitor.col.pid")} {detail.pid} · {detail.user || "—"}
                </div>
              </div>
            </div>

            <div className="sysmon-detail-meters">
              <div className="sysmon-detail-meter">
                <div className="sysmon-detail-meter-top">
                  <span>CPU</span>
                  <b>{detail.cpu.toFixed(1)}%</b>
                </div>
                <MiniChart values={detailHistory.map((s) => s.cpu)} />
              </div>
              <div className="sysmon-detail-meter">
                <div className="sysmon-detail-meter-top">
                  <span>{t("monitor.col.memory")}</span>
                  <b>{formatBytes(detail.memBytes)}</b>
                </div>
                <MiniChart values={detailHistory.map((s) => s.mem)} variant="mem" />
              </div>
            </div>

            <div className="sysmon-detail-ports-row">
              <span className="sysmon-detail-ports-label">{t("monitor.col.ports")}</span>
              {detail.ports.length ? (
                <span className="sysmon-detail-ports">
                  {detail.ports.map((p) => (
                    <em key={p} className="sysmon-port">
                      {p}
                    </em>
                  ))}
                </span>
              ) : (
                <span className="sysmon-detail-none">—</span>
              )}
            </div>

            {detail.count && detail.count > 1 && (
              <p className="sysmon-detail-note">{t("monitor.detail.groupNote", { pid: detail.pid })}</p>
            )}

            <div className="ws-dialog-actions">
              <button className="ws-dialog-btn" onClick={closeDetail}>
                {t("monitor.close")}
              </button>
              <button className="ws-dialog-btn" onClick={() => void kill(detail.pid, true)}>
                {t("monitor.killForce")}
              </button>
              <button
                className="ws-dialog-btn danger"
                autoFocus
                onClick={() => void kill(detail.pid, false)}
              >
                {t("monitor.kill")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
