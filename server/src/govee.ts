// Govee smart lights over the LAN — local UDP control, no API key, no cloud.
//
// Govee's LAN API (enable "LAN Control" per device in the Govee Home app):
//   - discovery: multicast a "scan" to 239.255.255.250:4001; devices reply to :4002
//   - control:   send commands to <device-ip>:4003 (fire-and-forget)
//   - status:    send "devStatus" to :4003; device replies to :4002
// Everything stays on your network. Verified against an H6062 at build time.
import dgram from "node:dgram";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const MULTICAST = "239.255.255.250";
const SCAN_PORT = 4001;
const RECV_PORT = 4002;
const CTRL_PORT = 4003;

type Device = { ip: string; sku: string; device: string };
type Reply = Record<string, unknown> & { _ip: string };
type Collector = { cmd: string; items: Reply[] };

let socket: dgram.Socket | null = null;
const collectors = new Set<Collector>();
let devices: Device[] = [];
let lastScan = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getSocket(): dgram.Socket {
  if (socket) return socket;
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  s.on("message", (buf, rinfo) => {
    let j: { msg?: { cmd?: string; data?: Record<string, unknown> } };
    try {
      j = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const cmd = j.msg?.cmd;
    if (!cmd) return;
    for (const c of collectors) {
      if (c.cmd === cmd) c.items.push({ ...(j.msg!.data ?? {}), _ip: rinfo.address });
    }
  });
  s.on("error", (e) => {
    console.error("[govee] socket error:", e.message);
    // A failed bind (port 4002 already taken) would otherwise leave this dead
    // socket cached forever, silently no-oping every later light command.
    // Dropping it means the next call builds a fresh one and can recover.
    if (socket === s) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
      socket = null;
    }
  });
  s.bind(RECV_PORT, () => {
    try {
      s.addMembership(MULTICAST);
    } catch {
      /* no multicast iface — unicast still works */
    }
    s.setMulticastTTL(4);
  });
  socket = s;
  return s;
}

/** Collect replies to a given command for `ms`, then stop listening. */
async function collect(cmd: string, send: () => void, ms = 1500): Promise<Reply[]> {
  getSocket();
  const c: Collector = { cmd, items: [] };
  collectors.add(c);
  try {
    send();
    await sleep(ms);
  } finally {
    collectors.delete(c);
  }
  return c.items;
}

/** Discover Govee LAN devices, cached for 60s. */
export async function goveeDiscover(force = false): Promise<Device[]> {
  if (!force && devices.length && Date.now() - lastScan < 60_000) return devices;
  const s = getSocket();
  const replies = await collect("scan", () => {
    const req = Buffer.from(JSON.stringify({ msg: { cmd: "scan", data: { account_topic: "reserve" } } }));
    s.send(req, SCAN_PORT, MULTICAST);
  });
  const seen = new Map<string, Device>();
  for (const r of replies) {
    if (typeof r.ip === "string" && typeof r.sku === "string") {
      seen.set(r.ip, { ip: r.ip, sku: r.sku, device: String(r.device ?? "") });
    }
  }
  devices = [...seen.values()];
  lastScan = Date.now();
  return devices;
}

function sendCmd(ip: string, cmd: string, data: Record<string, unknown>): void {
  const s = getSocket();
  const req = Buffer.from(JSON.stringify({ msg: { cmd, data } }));
  s.send(req, CTRL_PORT, ip);
}

/* ------------------------------ colour parsing ------------------------------ */

const NAMED: Record<string, [number, number, number]> = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255],
  orange: [255, 110, 0], yellow: [255, 220, 0], purple: [150, 0, 255], violet: [150, 0, 255],
  pink: [255, 60, 160], magenta: [255, 0, 200], cyan: [0, 220, 255], teal: [0, 200, 180],
  lime: [140, 255, 0], gold: [255, 180, 0], amber: [255, 140, 0], indigo: [75, 0, 200],
};
const TEMPS: Record<string, number> = {
  "warm white": 2700, warm: 2700, soft: 3000, neutral: 4000, "cool white": 5000, cool: 5000,
  daylight: 6500, "daylight white": 6500,
};

function parseColor(input: string): { rgb?: [number, number, number]; kelvin?: number } | null {
  const s = input.trim().toLowerCase();
  if (s in TEMPS) return { kelvin: TEMPS[s] };
  const hex = s.match(/^#?([0-9a-f]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
  }
  if (s in NAMED) return { rgb: NAMED[s] };
  return null;
}

/* ------------------------------ actions (shared) ------------------------------ */

async function targets(): Promise<Device[] | string> {
  const devs = await goveeDiscover();
  if (!devs.length) return "No Govee lights found on the network. Check that LAN Control is enabled for the device in the Govee Home app.";
  return devs;
}

export async function goveePower(on: boolean): Promise<string> {
  const t = await targets();
  if (typeof t === "string") return t;
  for (const d of t) sendCmd(d.ip, "turn", { value: on ? 1 : 0 });
  return `Turned the lights ${on ? "on" : "off"}.`;
}

export async function goveeBrightness(percent: number): Promise<string> {
  const t = await targets();
  if (typeof t === "string") return t;
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  for (const d of t) sendCmd(d.ip, "brightness", { value: v });
  return `Set brightness to ${v}%.`;
}

export async function goveeColor(color: string): Promise<string> {
  const parsed = parseColor(color);
  if (!parsed) return `I don't recognize the colour "${color}". Try a name (blue, warm white), or a hex like #ff8800.`;
  const t = await targets();
  if (typeof t === "string") return t;
  for (const d of t) {
    if (parsed.kelvin) sendCmd(d.ip, "colorwc", { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: parsed.kelvin });
    else sendCmd(d.ip, "colorwc", { color: { r: parsed.rgb![0], g: parsed.rgb![1], b: parsed.rgb![2] }, colorTemInKelvin: 0 });
  }
  return parsed.kelvin ? `Set the lights to ${parsed.kelvin}K white.` : `Set the lights to ${color}.`;
}

export async function goveeStatus(): Promise<string> {
  const devs = await goveeDiscover();
  if (!devs.length) return "No Govee lights found on the network.";
  const replies = await collect("devStatus", () => {
    for (const d of devs) sendCmd(d.ip, "devStatus", {});
  });
  if (!replies.length) return "The lights didn't report their status.";
  return replies
    .map((r) => {
      const on = r.onOff === 1 ? "on" : "off";
      const c = r.color as { r: number; g: number; b: number } | undefined;
      const kelvin = Number(r.colorTemInKelvin) || 0;
      const colour = kelvin > 0 ? `${kelvin}K white` : c ? `rgb(${c.r},${c.g},${c.b})` : "?";
      return `Lights (${r._ip}): ${on}, brightness ${r.brightness ?? "?"}%, ${colour}`;
    })
    .join("\n");
}

/* ------------------------------ MCP tools ------------------------------ */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const powerTool = tool(
  "lights_power",
  "Turn the Govee LED lights on or off.",
  { on: z.boolean().describe("true = on, false = off") },
  async ({ on }) => {
    try {
      return ok(await goveePower(on));
    } catch (e) {
      return fail(e);
    }
  },
);

const brightnessTool = tool(
  "lights_brightness",
  "Set the Govee LED brightness (0-100%).",
  { percent: z.number().min(0).max(100) },
  async ({ percent }) => {
    try {
      return ok(await goveeBrightness(percent));
    } catch (e) {
      return fail(e);
    }
  },
);

const colorTool = tool(
  "lights_color",
  "Set the Govee LED colour. Accepts a colour name (blue, red, warm white, daylight…) or a hex code like #ff8800.",
  { color: z.string().describe("Colour name, temperature (warm/cool white), or hex #rrggbb") },
  async ({ color }) => {
    try {
      return ok(await goveeColor(color));
    } catch (e) {
      return fail(e);
    }
  },
);

const statusTool = tool("lights_status", "Get the Govee LED lights' current power, brightness, and colour.", {}, async () => {
  try {
    return ok(await goveeStatus());
  } catch (e) {
    return fail(e);
  }
});

export const goveeServer = createSdkMcpServer({
  name: "govee",
  version: "0.1.0",
  instructions:
    "Control the user's Govee LED lights over the local network (no cloud). Use `lights_power` to turn on/off, `lights_brightness` (0-100), `lights_color` (name/temperature/hex), and `lights_status` to check current state.",
  tools: [powerTool, brightnessTool, colorTool, statusTool],
});
