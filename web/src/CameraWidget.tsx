import { useEffect, useRef, useState } from "react";

// A floating camera monitor you can drag anywhere and resize. Position/size are
// remembered between sessions. The <video> element is provided by the parent so
// camera.ts can attach the stream to it.

type Box = { x: number; y: number; w: number };
const KEY = "jarvis.cam.box";

function load(): Box {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "") as Box;
  } catch {
    return { x: window.innerWidth - 236, y: window.innerHeight - 320, w: 200 };
  }
}

export function CameraWidget({
  videoRef,
  onClose,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onClose: () => void;
}) {
  const [box, setBox] = useState<Box>(load);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(box));
  }, [box]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "move") {
        setBox((b) => ({
          ...b,
          x: Math.max(4, Math.min(window.innerWidth - b.w - 4, d.ox + (e.clientX - d.sx))),
          y: Math.max(4, Math.min(window.innerHeight - 80, d.oy + (e.clientY - d.sy))),
        }));
      } else {
        setBox((b) => ({ ...b, w: Math.max(120, Math.min(560, d.ow + (e.clientX - d.sx))) }));
      }
    }
    function onUp() {
      drag.current = null;
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const start = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.style.userSelect = "none";
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y, ow: box.w };
  };

  return (
    <div className="cam-widget" style={{ left: box.x, top: box.y, width: box.w }}>
      <div className="cam-head" onPointerDown={start("move")}>
        <span className="cam-dot" />
        <span className="cam-label">EYE · LIVE</span>
        <button className="cam-x" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="Close camera">
          ✕
        </button>
      </div>
      <video ref={videoRef} className="cam-video" playsInline muted />
      <div className="cam-resize" onPointerDown={start("resize")} title="Drag to resize" />
    </div>
  );
}
