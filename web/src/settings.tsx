import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// User-customizable look & feel, persisted locally and applied as CSS variables.

export type Accent = { name: string; amber: string; dim: string };

export const ACCENTS: Accent[] = [
  { name: "Phosphor", amber: "#f0a63c", dim: "#8a5f22" }, // default
  { name: "Reactor", amber: "#7cc6ff", dim: "#2f6a96" }, // Iron Man blue
  { name: "Vermilion", amber: "#ff5a45", dim: "#8f3128" },
  { name: "Acid", amber: "#c6f042", dim: "#5f7a1e" },
  { name: "Magenta", amber: "#ff5aa8", dim: "#8f2f5e" },
];

export type Settings = {
  name: string;
  accentIndex: number;
  scanlines: boolean;
  glow: boolean;
  reactor: boolean;
  fontScale: number; // 0.9 – 1.2
};

const DEFAULTS: Settings = {
  name: "JARVIS",
  accentIndex: 0,
  scanlines: true,
  glow: true,
  reactor: true,
  fontScale: 1,
};

const KEY = "jarvis.settings.v1";

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "") };
  } catch {
    return DEFAULTS;
  }
}

type Ctx = { settings: Settings; update: (patch: Partial<Settings>) => void; accent: Accent };
const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  const accent = ACCENTS[settings.accentIndex] ?? ACCENTS[0];

  // Apply to the document so every existing CSS var picks it up.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--amber", accent.amber);
    root.setProperty("--amber-dim", accent.dim);
    root.setProperty("--amber-glow", hexToGlow(accent.amber, 0.22));
    root.setProperty("--font-scale", String(settings.fontScale));
    document.body.dataset.scanlines = String(settings.scanlines);
    document.body.dataset.glow = String(settings.glow);
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings, accent]);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  return <SettingsContext.Provider value={{ settings, update, accent }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings outside provider");
  return ctx;
}

function hexToGlow(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
