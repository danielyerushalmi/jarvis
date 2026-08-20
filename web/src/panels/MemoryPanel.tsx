import { useEffect, useState } from "react";
import { apiFetch } from "../api";

type Memory = {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  kind?: "fact" | "episode";
  importance?: "normal" | "high";
  supersededBy?: string;
  occurredAt?: string;
};
type Stats = { facts: number; episodes: number; superseded: number };

export function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  // Without the catch, a backend that's down leaves this on "Loading…" forever
  // (plus an unhandled rejection in the console) with no hint why.
  async function refresh() {
    try {
      const res = await apiFetch("/memory");
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      const body = (await res.json()) as { memories: Memory[]; stats?: Stats };
      setMemories(body.memories);
      setStats(body.stats ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't reach the backend");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function forget(id: string) {
    try {
      const res = await apiFetch(`/memory/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      setMemories((m) => m?.filter((x) => x.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't forget that");
    }
  }

  // Retired memories are hidden by default — they're history, not current
  // knowledge, and Jarvis no longer recalls them.
  const shown = (memories ?? [])
    .filter((m) => showRetired || !m.supersededBy)
    .filter((m) => m.text.toLowerCase().includes(filter.toLowerCase()));

  async function clearRetired() {
    try {
      const res = await apiFetch("/memory/superseded", { method: "DELETE" });
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't clear those");
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Long-term memory</h2>
        <p>
          What Jarvis remembers about you, stored locally. <strong>Facts</strong> are recalled automatically;{" "}
          <strong>episodes</strong> are things that happened, found when it searches. Just tell it things in chat to add
          more.
        </p>
        {stats && (
          <p className="mem-meta">
            <span>{stats.facts} facts</span>
            <span>{stats.episodes} episodes</span>
            {stats.superseded > 0 && (
              <>
                <span>{stats.superseded} retired</span>
                <button className="mem-del" onClick={() => setShowRetired((v) => !v)}>
                  {showRetired ? "hide retired" : "show retired"}
                </button>
                <button className="mem-del" onClick={clearRetired} title="Delete retired memories for good">
                  clear retired
                </button>
              </>
            )}
          </p>
        )}
        <input className="panel-search" placeholder="Filter memories…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error ? (
        <p className="panel-empty">Couldn't reach the backend — {error}.</p>
      ) : memories === null ? (
        <p className="panel-empty">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="panel-empty">{memories.length ? "No matches." : "Nothing remembered yet."}</p>
      ) : (
        <ul className="mem-list">
          {shown.map((m) => (
            <li key={m.id} className="mem-item" style={m.supersededBy ? { opacity: 0.45 } : undefined}>
              <div className="mem-body">
                <p className="mem-text">{m.text}</p>
                <div className="mem-meta">
                  <span>{new Date(m.occurredAt ?? m.createdAt).toLocaleDateString()}</span>
                  {m.kind === "episode" && <span className="mem-tag">episode</span>}
                  {m.importance === "high" && <span className="mem-tag">important</span>}
                  {m.supersededBy && <span className="mem-tag">retired</span>}
                  {m.tags.map((t) => (
                    <span key={t} className="mem-tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <button className="mem-del" onClick={() => forget(m.id)} title="Forget this">
                forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
