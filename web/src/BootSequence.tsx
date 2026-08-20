import { Reactor } from "./Reactor";

// A brief power-on readout shown on load — subsystems coming online, then it
// dissolves into the console. Pure CSS staggered reveal; skipped-ish under
// reduced motion (lines just show statically).
const LINES = [
  "core ................ linked",
  "long-term memory .... online",
  "senses · mic / eye .. online",
  "neural voice ........ ready",
  "network ............. linked",
  "all systems ......... nominal",
];

export function BootSequence({ name }: { name: string }) {
  return (
    <div className="boot" aria-hidden>
      <div className="boot-inner">
        <div className="boot-reactor">
          <Reactor vibe="thinking" size={72} />
        </div>
        <div className="boot-title">{name}</div>
        <div className="boot-sub">workshop console</div>
        <ul className="boot-log">
          {LINES.map((l, i) => (
            <li key={i} style={{ animationDelay: `${0.25 + i * 0.16}s` }}>
              <span className="boot-ok">▪</span> {l}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
