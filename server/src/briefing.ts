// Weather + news, for briefings and "what's the weather" questions.
//
// Both sources are FREE and need NO API KEY:
//   - Weather: Open-Meteo (forecast + geocoding).
//   - News: any RSS feed, via rss-parser.
// Fetching costs zero Claude tokens — only narrating the result spends a turn.
//
// Location + feeds are read from ~/.jarvis/briefing.json (or env), so the user
// can set a home location once and just ask "what's the weather".
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Parser from "rss-parser";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const CONFIG_FILE = process.env.JARVIS_BRIEFING_FILE ?? join(homedir(), ".jarvis", "briefing.json");

type BriefingConfig = {
  lat?: number;
  lon?: number;
  city?: string;
  feeds?: string[];
};

// Sensible default feeds so "what's the news" works out of the box; override by
// putting {"feeds": [...]} in the config file.
const DEFAULT_FEEDS = [
  "https://feeds.npr.org/1001/rss.xml",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
];

function loadConfig(): BriefingConfig {
  let cfg: BriefingConfig = {};
  try {
    if (existsSync(CONFIG_FILE)) cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as BriefingConfig;
  } catch {
    /* unreadable config — carry on with whatever the env provides */
  }
  // Env wins for location, but only for location: it must not discard the rest
  // of the file (custom `feeds` used to vanish whenever JARVIS_LAT was set).
  // `city` goes with the coordinates it named, so it's dropped too rather than
  // labelling the env's coordinates with an unrelated place name.
  if (process.env.JARVIS_LAT && process.env.JARVIS_LON) {
    cfg = { ...cfg, lat: Number(process.env.JARVIS_LAT), lon: Number(process.env.JARVIS_LON), city: undefined };
  }
  return cfg;
}

// WMO weather codes → short human text (Open-Meteo's `weather_code`).
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

async function geocode(city: string): Promise<{ lat: number; lon: number; label: string }> {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`geocoding failed (${res.status})`);
  const body = (await res.json()) as {
    results?: { latitude: number; longitude: number; name: string; country?: string }[];
  };
  const hit = body.results?.[0];
  if (!hit) throw new Error(`couldn't find a place called "${city}"`);
  return { lat: hit.latitude, lon: hit.longitude, label: `${hit.name}${hit.country ? `, ${hit.country}` : ""}` };
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const parser = new Parser({ timeout: 10_000 });

/** Current weather + today's forecast as text. Shared by the MCP tool and the
 *  local-model tool loop. Throws on fetch failure. */
export async function getWeather(location?: string): Promise<string> {
  const cfg = loadConfig();
  let lat: number, lon: number, label: string;
  if (location) {
    ({ lat, lon, label } = await geocode(location));
  } else if (cfg.lat != null && cfg.lon != null) {
    lat = cfg.lat;
    lon = cfg.lon;
    label = cfg.city ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  } else {
    return 'No home location is set. Tell me a city (e.g. "weather in Toronto"), or save one in ~/.jarvis/briefing.json as {"lat":..,"lon":..,"city":".."}.';
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`weather fetch failed (${res.status})`);
  const w = (await res.json()) as {
    current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] };
  };
  const desc = WEATHER_CODES[w.current.weather_code] ?? `code ${w.current.weather_code}`;
  return (
    `Weather for ${label}:\n` +
    `- Now: ${w.current.temperature_2m}°C (feels ${w.current.apparent_temperature}°C), ${desc}, wind ${w.current.wind_speed_10m} km/h\n` +
    `- Today: high ${w.daily.temperature_2m_max[0]}°C / low ${w.daily.temperature_2m_min[0]}°C, ` +
    `${w.daily.precipitation_probability_max[0]}% chance of precipitation`
  );
}

/** Latest headlines as text. Shared by the MCP tool and the local-model loop. */
export async function getNews(limit = 8): Promise<string> {
  const cfg = loadConfig();
  const feeds = cfg.feeds?.length ? cfg.feeds : DEFAULT_FEEDS;
  const results = await Promise.allSettled(feeds.map((f) => parser.parseURL(f)));

  // One list per feed, then interleaved. Concatenating and slicing to `limit`
  // meant the first feed filled the quota and later ones never appeared at all.
  const perFeed = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof parser.parseURL>>> => r.status === "fulfilled")
    .map((r) => {
      const source = r.value.title ?? "feed";
      return r.value.items.filter((i) => i.title).map((i) => `- ${i.title!.trim()} (${source})`);
    })
    .filter((list) => list.length);

  const headlines: string[] = [];
  for (let round = 0; headlines.length < limit; round++) {
    const before = headlines.length;
    for (const list of perFeed) {
      if (round < list.length && headlines.length < limit) headlines.push(list[round]);
    }
    if (headlines.length === before) break; // every feed exhausted
  }

  if (!headlines.length) return "Couldn't fetch any headlines right now.";
  return `Latest headlines:\n${headlines.join("\n")}`;
}

const weatherTool = tool(
  "weather",
  "Get current weather and today's forecast. Pass a city name, or leave it blank to use the user's saved home location. Free and keyless — costs no tokens to fetch.",
  { location: z.string().optional().describe("City name, e.g. 'Toronto'. Omit to use the saved location.") },
  async ({ location }) => {
    try {
      return ok(await getWeather(location));
    } catch (e) {
      return fail(e);
    }
  },
);

const newsTool = tool(
  "news",
  "Get the latest news headlines from the user's configured RSS feeds (defaults to NPR + BBC World). Free and keyless. Optionally limit how many headlines.",
  { limit: z.number().int().optional().describe("Max headlines to return (default 8)") },
  async ({ limit }) => {
    try {
      return ok(await getNews(limit ?? 8));
    } catch (e) {
      return fail(e);
    }
  },
);

export const briefingServer = createSdkMcpServer({
  name: "briefing",
  version: "0.1.0",
  instructions:
    "Weather and news for briefings and quick questions. Both are free and keyless, so fetching costs no tokens. Use `weather` for current conditions/forecast (pass a city or rely on the saved location) and `news` for headlines. For a morning briefing, combine both plus anything from `list_scheduled`.",
  tools: [weatherTool, newsTool],
});
