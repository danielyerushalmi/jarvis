import { useEffect, useRef } from "react";
import { sampleBars } from "./audiolevel";

// The arc reactor — Jarvis's centrepiece. It breathes when idle, spins while
// thinking, glows teal while listening, and pulses when speaking.
//
// With `parallax`, it becomes cursor-reactive: the whole assembly tilts in 3D
// toward the pointer (smoothly lerped), so the hero feels simulated rather than
// like a looping screensaver. Disabled under prefers-reduced-motion.

export type Vibe = "idle" | "listening" | "thinking" | "speaking";

export function Reactor({ vibe, size = 132, parallax = false }: { vibe: Vibe; size?: number; parallax?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = vibe === "listening" || vibe === "speaking";

  // Live spectrum ring: while listening/speaking, draw real audio frequencies
  // (mic input or Jarvis's own voice) as a ring of teal bars around the core.
  useEffect(() => {
    const canvas = canvasRef.current;
    const cctx = canvas?.getContext("2d");
    if (!canvas || !cctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    cctx.scale(dpr, dpr);
    cctx.clearRect(0, 0, size, size);
    if (!live || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const teal = getComputedStyle(document.documentElement).getPropertyValue("--live").trim() || "#35d0c0";
    const N = 56;
    const cx = size / 2;
    const cy = size / 2;
    const r0 = size * 0.3;
    const maxLen = size * 0.16;
    let raf = 0;
    const draw = () => {
      cctx.clearRect(0, 0, size, size);
      const bars = sampleBars(N);
      cctx.lineCap = "round";
      cctx.lineWidth = Math.max(1, size * 0.012);
      cctx.strokeStyle = teal;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 - Math.PI / 2;
        const len = maxLen * (0.12 + bars[i] * 0.88);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        cctx.globalAlpha = 0.3 + bars[i] * 0.7;
        cctx.beginPath();
        cctx.moveTo(cx + ca * r0, cy + sa * r0);
        cctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
        cctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [live, size]);

  useEffect(() => {
    if (!parallax) return;
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let targetX = 0, targetY = 0, curX = 0, curY = 0, raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      targetX = Math.max(-1, Math.min(1, ((e.clientX - (r.left + r.width / 2)) / window.innerWidth) * 2.4));
      targetY = Math.max(-1, Math.min(1, ((e.clientY - (r.top + r.height / 2)) / window.innerHeight) * 2.4));
    };
    const loop = () => {
      curX += (targetX - curX) * 0.07; // lerp toward the pointer — weight, no snap
      curY += (targetY - curY) * 0.07;
      el.style.setProperty("--px", curX.toFixed(3));
      el.style.setProperty("--py", curY.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("pointermove", onMove);
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [parallax]);

  return (
    <div
      ref={ref}
      className={`reactor vibe-${vibe} ${parallax ? "reactor-3d" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 100 100" className="reactor-svg">
        {/* outer ticks — the housing */}
        <g className="ticks">
          {Array.from({ length: 36 }).map((_, i) => (
            <line key={i} x1="50" y1="4" x2="50" y2={i % 3 === 0 ? 9 : 7} transform={`rotate(${i * 10} 50 50)`} />
          ))}
        </g>
        {/* orbital data ring — fine instrument ticks, slowly counter-rotating */}
        <g className="data-ring">
          {Array.from({ length: 48 }).map((_, i) => (
            <line key={i} x1="50" y1="43" x2="50" y2={i % 4 === 0 ? 46.5 : 45} transform={`rotate(${i * 7.5} 50 50)`} />
          ))}
        </g>
        {/* rotating coil ring */}
        <circle className="ring ring-outer" cx="50" cy="50" r="38" />
        <circle className="ring ring-mid" cx="50" cy="50" r="29" />
        {/* segmented coils */}
        <g className="coils">
          {Array.from({ length: 8 }).map((_, i) => (
            <rect key={i} x="47.5" y="14" width="5" height="10" rx="1.5" transform={`rotate(${i * 45} 50 50)`} />
          ))}
        </g>
        {/* the glowing core */}
        <circle className="core-halo" cx="50" cy="50" r="17" />
        <circle className="core" cx="50" cy="50" r="11" />
        <circle className="core-hot" cx="50" cy="50" r="5" />
      </svg>
      <canvas ref={canvasRef} className="reactor-canvas" style={{ width: size, height: size }} />
      {live && <div className="reactor-wave" />}
    </div>
  );
}
