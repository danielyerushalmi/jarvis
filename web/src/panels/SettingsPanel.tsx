import { useEffect, useState } from "react";
import { ACCENTS, useSettings } from "../settings";
import { apiFetch, withToken } from "../api";

type SpotifyStatus = { configured: boolean; connected: boolean };

export function SettingsPanel() {
  const { settings, update } = useSettings();

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Customize</h2>
        <p>Make it yours. Everything here is saved on this machine.</p>
      </div>

      <div className="set-grid">
        <label className="set-row">
          <span className="set-k">Name</span>
          <input className="set-input" value={settings.name} maxLength={16} onChange={(e) => update({ name: e.target.value.toUpperCase() })} />
        </label>

        <div className="set-row">
          <span className="set-k">Accent</span>
          <div className="swatches">
            {ACCENTS.map((a, i) => (
              <button
                key={a.name}
                className={`swatch ${settings.accentIndex === i ? "sel" : ""}`}
                style={{ background: a.amber }}
                title={a.name}
                onClick={() => update({ accentIndex: i })}
              />
            ))}
          </div>
        </div>

        <label className="set-row">
          <span className="set-k">Text size</span>
          <input
            className="set-range"
            type="range"
            min={0.9}
            max={1.2}
            step={0.05}
            value={settings.fontScale}
            onChange={(e) => update({ fontScale: Number(e.target.value) })}
          />
        </label>

        <Toggle k="Arc reactor" v={settings.reactor} on={() => update({ reactor: !settings.reactor })} />
        <Toggle k="Scanlines" v={settings.scanlines} on={() => update({ scanlines: !settings.scanlines })} />
        <Toggle k="Ambient glow" v={settings.glow} on={() => update({ glow: !settings.glow })} />

        <Spotify />
      </div>

      <p className="set-note">
        The break-nudge timer and always-on startup are set on the backend — see the README
        (<code>JARVIS_BREAK_MINUTES</code>, <code>npm run autostart</code>).
      </p>
    </div>
  );
}

function Spotify() {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);

  const refresh = () =>
    apiFetch("/spotify/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void refresh();
    // Re-check when the tab regains focus (e.g. after finishing the connect flow).
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const state = !status
    ? "…"
    : !status.configured
      ? "no client ID"
      : status.connected
        ? "connected"
        : "not connected";

  return (
    <div className="set-row">
      <span className="set-k">Spotify</span>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span className="v">{state}</span>
        {status?.configured && !status.connected && (
          <button className="switch on" style={{ width: "auto", padding: "0 0.7rem" }} onClick={() => window.open(withToken("/spotify/login"), "_blank")}>
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

function Toggle({ k, v, on }: { k: string; v: boolean; on: () => void }) {
  return (
    <div className="set-row">
      <span className="set-k">{k}</span>
      <button className={`switch ${v ? "on" : ""}`} onClick={on} role="switch" aria-checked={v}>
        <span className="knob" />
      </button>
    </div>
  );
}
