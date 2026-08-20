import { useEffect, useState } from "react";
import { apiFetch } from "./api";

// Persistent instrument footer: live clock + machine vitals (CPU/RAM/battery),
// polled from the backend's zero-token /system endpoint. Reads like the bottom
// readout of a real console panel.

type Stats = { cpu: number; memUsedGb: number; memTotalGb: number; battery: number | null };

function level(pct: number): string {
  return pct >= 85 ? "hot" : pct >= 60 ? "warm" : "";
}

export function SystemBar({ online }: { online: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [clock, setClock] = useState("");

  // Client-side clock — free, ticks every second.
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString(undefined, { hour12: false }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // Poll machine vitals. The backend caches for ~4s, so 6s here is comfortable.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      apiFetch("/system")
        .then((r) => r.json())
        .then((s: Stats) => alive && setStats(s))
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const memPct = stats && stats.memTotalGb ? (stats.memUsedGb / stats.memTotalGb) * 100 : 0;

  return (
    <footer className="sysbar" aria-hidden>
      <span className={`sys-led ${online ? "on" : "off"}`} />
      <span className="sys-status">{online ? "ONLINE" : "OFFLINE"}</span>
      <span className="sys-div" />
      {stats ? (
        <>
          <Metric k="CPU" v={`${stats.cpu}%`} pct={stats.cpu} cls={level(stats.cpu)} />
          <Metric k="MEM" v={`${stats.memUsedGb.toFixed(1)}/${stats.memTotalGb.toFixed(0)}G`} pct={memPct} cls={level(memPct)} />
          {stats.battery != null ? (
            <Metric k="BAT" v={`${stats.battery}%`} pct={stats.battery} cls={stats.battery <= 20 ? "hot" : ""} />
          ) : (
            <span className="sys-metric">
              <span className="sys-mk">PWR</span>
              <span className="sys-mv">AC</span>
            </span>
          )}
        </>
      ) : (
        <span className="sys-reading">reading telemetry…</span>
      )}
      <span className="sys-clock">{clock}</span>
    </footer>
  );
}

function Metric({ k, v, pct, cls }: { k: string; v: string; pct: number; cls: string }) {
  return (
    <span className={`sys-metric ${cls}`}>
      <span className="sys-mk">{k}</span>
      <span className="sys-meter">
        <span className="sys-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="sys-mv">{v}</span>
    </span>
  );
}
