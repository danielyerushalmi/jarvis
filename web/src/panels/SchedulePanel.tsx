import { useEffect, useState } from "react";
import { apiFetch } from "../api";

type Job = { id: string; text: string; cron: string | null; at: string | null; speak: boolean };

export function SchedulePanel() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This polls every 5s, so an uncaught rejection here would spam the console
  // indefinitely while the panel sat on "Loading…".
  async function refresh() {
    try {
      const res = await apiFetch("/jobs");
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      const { jobs } = (await res.json()) as { jobs: Job[] };
      setJobs(jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't reach the backend");
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);

  async function cancel(id: string) {
    try {
      const res = await apiFetch(`/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`backend returned ${res.status}`);
      setJobs((j) => j?.filter((x) => x.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't cancel that");
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Scheduled tasks</h2>
        <p>Reminders and recurring jobs. Add them in chat — "remind me in 20 minutes to…".</p>
      </div>
      {error && jobs === null ? (
        <p className="panel-empty">Couldn't reach the backend — {error}.</p>
      ) : jobs === null ? (
        <p className="panel-empty">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="panel-empty">Nothing scheduled.</p>
      ) : (
        <ul className="job-list">
          {jobs.map((j) => (
            <li key={j.id} className="job-item">
              <div className="job-when">
                <span className={`job-kind ${j.speak ? "speak" : ""}`}>{j.speak ? "task" : "ping"}</span>
                {j.cron ? <code>{j.cron}</code> : new Date(j.at!).toLocaleString()}
              </div>
              <span className="job-text">{j.text}</span>
              <button className="mem-del" onClick={() => cancel(j.id)} title="Cancel">
                cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
