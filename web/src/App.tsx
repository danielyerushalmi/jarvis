import { useEffect, useRef, useState } from "react";
import { useJarvis } from "./useJarvis";
import { Markdown } from "./Markdown";
import { cancelSpeech, onSpeaking, ttsSupported } from "./voice";
import { MicRecorder, micDiagnosis, micSupported, transcribe } from "./stt";
import { WakeListener, wakeSupported } from "./wake";
import { cameraSupported, captureFrame, startCamera, stopCamera } from "./camera";
import { Reactor, type Vibe } from "./Reactor";
import { BootSequence } from "./BootSequence";
import { SystemBar } from "./SystemBar";
import { CameraWidget } from "./CameraWidget";
import { useSettings } from "./settings";
import { MemoryPanel } from "./panels/MemoryPanel";
import { SchedulePanel } from "./panels/SchedulePanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import type { ImageInput, ToolCall } from "./types";
import { apiFetch } from "./api";

type Tab = "console" | "memory" | "schedule" | "settings";
type Attachment = { kind: "image"; data: ImageInput; name: string } | { kind: "file"; path: string; name: string };

export default function App() {
  const jarvis = useJarvis();
  const { settings } = useSettings();
  const [tab, setTab] = useState<Tab>("console");
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [booting, setBooting] = useState(true);
  const [wakeOn, setWakeOn] = useState(false);
  const [awake, setAwake] = useState(false); // "Jarvis" heard, capturing the command

  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const micRef = useRef<MicRecorder | null>(null);
  if (!micRef.current) micRef.current = new MicRecorder();
  const magnet = useMagnetic();
  const wakeRef = useRef<WakeListener | null>(null);

  useEffect(() => () => stopCamera(), []);
  useEffect(() => onSpeaking(setSpeaking), []);
  useEffect(() => () => void wakeRef.current?.stop(), []); // tear down the mic on unmount
  // Power-on sequence: play the boot readout once, then settle into the console.
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 2100);
    return () => clearTimeout(t);
  }, []);

  // Global hotkey → toggle listening even when the tab isn't focused.
  useEffect(() => {
    if (jarvis.hotkeySignal > 0) {
      setTab("console");
      void toggleMic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jarvis.hotkeySignal]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [jarvis.messages, jarvis.streamingText, jarvis.turnTools]);

  const busy = jarvis.status === "thinking";
  const vibe: Vibe = speaking ? "speaking" : listening || transcribing || awake ? "listening" : busy ? "thinking" : "idle";
  const link =
    jarvis.status === "connecting"
      ? { cls: "warn", label: "down" }
      : busy
        ? { cls: "live", label: "busy" }
        : { cls: "on", label: "ready" };

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
      setCameraOn(false);
      return;
    }
    setCamError(null);
    setCameraOn(true);
    try {
      await new Promise((r) => setTimeout(r, 0));
      if (!videoRef.current) throw new Error("no video element");
      await startCamera(videoRef.current);
    } catch (err) {
      // Must release the stream too. Leaving it behind used to poison every later
      // attempt: startCamera() saw a stream, returned early without binding the
      // video element, and the eye then read "live" while no frame was ever
      // captured — with no error to explain it.
      stopCamera();
      setCameraOn(false);
      setCamError(err instanceof Error ? err.message : "camera failed");
    }
  }

  function send(text: string) {
    const images: ImageInput[] = attachments.filter((a) => a.kind === "image").map((a) => (a as { data: ImageInput }).data);
    if (cameraOn) {
      const frame = captureFrame();
      if (frame) {
        images.push(frame);
        setCamError(null);
      } else {
        // Say so. Silently sending a "look at this" turn with no frame is what
        // made the eye appear to work while Jarvis insisted it couldn't see.
        setCamError("couldn't grab a frame — give the camera a moment, or toggle the eye off and on");
      }
    }
    const files = attachments.filter((a) => a.kind === "file") as Extract<Attachment, { kind: "file" }>[];
    let body = text.trim();
    if (files.length) {
      body += `\n\n[I've placed ${files.length} file(s) in your workspace — read them if useful:\n${files
        .map((f) => `- ${f.path}`)
        .join("\n")}]`;
    }
    if (!body && !images.length) return;
    jarvis.send(body || "(look)", images);
    setAttachments([]);
  }

  // Always-listening "Jarvis" wake word (opt-in) via local VAD + Whisper. When it
  // recognizes "Jarvis", the trailing command is sent as a normal turn.
  async function toggleWake() {
    if (wakeOn) {
      await wakeRef.current?.stop();
      wakeRef.current = null;
      setWakeOn(false);
      setAwake(false);
      return;
    }
    setMicError(null);
    const listener = new WakeListener({
      onWake: () => {
        setTab("console");
        cancelSpeech(); // barge-in: stop any spoken reply the moment you address it
        setAwake(true);
        setTimeout(() => setAwake(false), 8500); // clear the indicator if no command follows
      },
      onCommand: (text) => {
        setAwake(false);
        send(text);
      },
      onError: (msg) => {
        setMicError(msg);
        setWakeOn(false);
        setAwake(false);
        wakeRef.current = null;
      },
    });
    try {
      await listener.start();
      wakeRef.current = listener;
      setWakeOn(true);
    } catch {
      /* onError already surfaced the message */
    }
  }

  async function toggleMic() {
    const mic = micRef.current!;
    setMicError(null);
    if (!listening) {
      try {
        await mic.start();
        setListening(true);
      } catch (err) {
        setMicError(err instanceof Error ? err.message : "microphone unavailable");
      }
      return;
    }
    setListening(false);
    setTranscribing(true);
    try {
      const wav = await mic.stop();
      if (wav) {
        const text = await transcribe(wav);
        if (text) send(text);
        else setMicError("didn't catch that — try again");
      }
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "transcription failed");
    } finally {
      setTranscribing(false);
    }
  }

  // Drag-and-drop: images become vision, other files upload to the workspace.
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    setTab("console");
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith("image/")) {
        const data = await fileToBase64(file);
        setAttachments((a) => [...a, { kind: "image", name: file.name, data: { mediaType: file.type, data } }]);
      } else {
        try {
          const res = await apiFetch(`/upload?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          });
          const { path } = (await res.json()) as { path: string };
          setAttachments((a) => [...a, { kind: "file", name: file.name, path }]);
        } catch {
          setMicError(`couldn't upload ${file.name}`);
        }
      }
    }
  }

  return (
    <div
      className={`app ${booting ? "booting" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          {settings.reactor ? <Reactor vibe={vibe} size={30} /> : <span className="logo">◈</span>}
          <span className="brand-name">{settings.name}</span>
        </div>

        <div className="rail">
          <Gauge cls={link.cls} k="link" v={link.label} title="Connection to the Jarvis backend" />
          <div className="gauge on" title="Which brain answers — switch to a smaller or local model to save usage">
            <span className="led" />
            <span className="k">brain</span>
            {jarvis.models.length > 0 ? (
              <select className="brainsel" value={jarvis.model ?? ""} onChange={(e) => jarvis.setModel(e.target.value)}>
                {jarvis.models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="v">{jarvis.model ?? "—"}</span>
            )}
          </div>
          <Gauge
            cls={listening || transcribing ? "live" : !micSupported ? "warn" : ""}
            k="mic"
            v={!micSupported ? "n/a" : transcribing ? "proc" : listening ? "live" : "idle"}
            title={micSupported ? "Speech input (local Whisper)" : (micDiagnosis() ?? "unavailable")}
          />
          <Gauge cls={cameraOn ? "live" : ""} k="eye" v={cameraOn ? "live" : "off"} title="Camera" />
          {ttsSupported && (
            <div className={`gauge ${jarvis.ttsEnabled ? "on" : ""}`}>
              <span className="led" />
              <span className="k">vox</span>
              <button onClick={jarvis.toggleTts} title="Toggle spoken replies">
                {jarvis.ttsEnabled ? "on" : "off"}
              </button>
            </div>
          )}
          {wakeSupported && (
            <div className={`gauge ${wakeOn ? (awake ? "live" : "on") : ""}`}>
              <span className="led" />
              <span className="k">wake</span>
              <button onClick={() => void toggleWake()} title="Always-listening 'Hey Jarvis' wake word — local, opt-in">
                {wakeOn ? (awake ? "…" : "on") : "off"}
              </button>
            </div>
          )}
          {jarvis.costUsd !== null && (
            <div
              className="gauge cost"
              title={`This run: $${jarvis.costUsd.toFixed(4)}${jarvis.lastTurnCostUsd ? ` · last +$${jarvis.lastTurnCostUsd.toFixed(4)}` : ""}\n\nNotional on a subscription — counts toward usage, not billed. Switch to haiku or local to spend less.`}
            >
              <span className="k">cost</span>
              <span className="v">${jarvis.costUsd.toFixed(2)}</span>
              {jarvis.lastTurnCostUsd !== null && <span className="delta">+{jarvis.lastTurnCostUsd.toFixed(3)}</span>}
            </div>
          )}
        </div>
      </header>

      <nav className="tabs">
        {(["console", "memory", "schedule", "settings"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "sel" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <button className="tab newchat" onClick={jarvis.newChat} title="Start a fresh session">
          new session
        </button>
      </nav>

      {tab === "memory" && <MemoryPanel />}
      {tab === "schedule" && <SchedulePanel />}
      {tab === "settings" && <SettingsPanel />}

      {tab === "console" && (
        <>
          <main className="thread" ref={scrollRef}>
            {jarvis.messages.length === 0 && (
              <div className="empty">
                {settings.reactor && <Reactor vibe={vibe} size={150} parallax />}
                <div className="empty-logo">{settings.name}</div>
                <p>Speak, type, drop a file, or show me something.</p>
              </div>
            )}

            {jarvis.messages.map((m, i) =>
              m.role === "system" ? (
                <div key={i} className="proactive-divider">
                  <span>⏰ started automatically — {m.text}</span>
                </div>
              ) : (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="bubble">
                    {m.role === "assistant" ? (
                      <Markdown text={m.text} />
                    ) : (
                      <p className="text">
                        {m.sawImage && <span className="saw-image" title="an image was attached">🖼</span>}
                        {m.text}
                      </p>
                    )}
                    {m.role === "assistant" && m.tools.length > 0 && (
                      <div className="tools-inline">
                        {m.tools.map((t) => (
                          <ToolChip key={t.id} tool={t} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}

            {jarvis.streamingText && (
              <div className="msg assistant">
                <div className="bubble">
                  <Markdown text={jarvis.streamingText} />
                  <span className="caret" />
                </div>
              </div>
            )}

            {busy && jarvis.turnTools.length > 0 && (
              <div className="activity">
                {jarvis.turnTools.map((t) => (
                  <ToolChip key={t.id} tool={t} live />
                ))}
              </div>
            )}
            {busy && !jarvis.streamingText && jarvis.turnTools.length === 0 && (
              <div className="thinking">
                <span className="pulse" /> working…
              </div>
            )}
          </main>

          {camError && <div className="statusline warn">camera: {camError}</div>}
          {micError && <div className="statusline warn">🎤 {micError}</div>}
          {(listening || transcribing) && (
            <div className="statusline">
              <span className="mic-pulse" />
              {transcribing ? "transcribing locally…" : "listening — click the mic again when you're done"}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((a, i) => (
                <span key={i} className={`attach ${a.kind}`}>
                  {a.kind === "image" ? "🖼" : "📄"} {a.name}
                  <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
            </div>
          )}

          <footer className="composer">
            <button
              className={`iconbtn pad ${listening ? "on" : ""}`}
              onClick={toggleMic}
              disabled={!micSupported || transcribing}
              title={!micSupported ? (micDiagnosis() ?? "Microphone unavailable") : listening ? "Click to stop and send" : "Speak (local Whisper)"}
            >
              {transcribing ? "…" : listening ? "◉" : "🎤"}
            </button>
            <button
              className={`iconbtn pad ${cameraOn ? "on" : ""}`}
              onClick={toggleCamera}
              disabled={!cameraSupported}
              title={cameraOn ? "Camera on — click to turn off" : "Let Jarvis see through your webcam"}
            >
              {cameraOn ? "📸" : "📷"}
            </button>
            <textarea
              value={draft}
              placeholder={busy ? "Jarvis is working…" : "Ask Jarvis…"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) {
                    send(draft);
                    setDraft("");
                  }
                }
              }}
              rows={1}
            />
            {busy ? (
              <button
                className="send stop"
                ref={magnet.ref}
                onPointerMove={magnet.onPointerMove}
                onPointerLeave={magnet.onPointerLeave}
                onClick={jarvis.interruptTurn}
              >
                Stop
              </button>
            ) : (
              <button
                className="send"
                ref={magnet.ref}
                onPointerMove={magnet.onPointerMove}
                onPointerLeave={magnet.onPointerLeave}
                onClick={() => {
                  send(draft);
                  setDraft("");
                }}
                // With the camera on, a frame rides along and send() turns an
                // empty draft into "(look)" — Enter already allowed that, so the
                // button shouldn't be the one thing refusing it.
                disabled={!draft.trim() && attachments.length === 0 && !cameraOn}
              >
                Send
              </button>
            )}
          </footer>
        </>
      )}

      {booting && <BootSequence name={settings.name} />}

      <div className="hud-frame" aria-hidden>
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />
      </div>

      <SystemBar online={jarvis.status !== "connecting"} />

      {cameraOn && <CameraWidget videoRef={videoRef} onClose={() => void toggleCamera()} />}

      {dragging && (
        <div className="dropzone">
          <div className="dropzone-inner">Drop images or files — Jarvis will see them</div>
        </div>
      )}

      {jarvis.permission && (
        <div className="modal-scrim">
          <div className="modal">
            <div className="modal-title">{jarvis.permission.title ?? `Jarvis wants to use ${jarvis.permission.toolName}`}</div>
            {jarvis.permission.reason && <p className="modal-reason">Held for approval — {jarvis.permission.reason}</p>}
            {jarvis.permission.description && <p className="modal-desc">{jarvis.permission.description}</p>}
            <pre className="modal-input">{formatInput(jarvis.permission.input)}</pre>
            <div className="modal-actions">
              <button className="deny" onClick={() => jarvis.respondPermission(jarvis.permission!.id, false)}>
                Deny
              </button>
              <button className="approve" onClick={() => jarvis.respondPermission(jarvis.permission!.id, true)}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// "Never inert": the primary action leans toward the cursor as it approaches,
// then eases back on leave (CSS transition handles the return). Off under
// prefers-reduced-motion.
function useMagnetic(strength = 0.35) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onPointerMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (reduced || !el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - (r.left + r.width / 2);
    const my = e.clientY - (r.top + r.height / 2);
    el.style.transform = `translate(${(mx * strength).toFixed(1)}px, ${(my * strength).toFixed(1)}px)`;
  };
  const onPointerLeave = () => {
    if (ref.current) ref.current.style.transform = "";
  };
  return { ref, onPointerMove, onPointerLeave };
}

function Gauge({ cls, k, v, title }: { cls: string; k: string; v: string; title: string }) {
  return (
    <div className={`gauge ${cls}`} title={title}>
      <span className="led" />
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

function ToolChip({ tool, live }: { tool: ToolCall; live?: boolean }) {
  return (
    <span className={`chip ${live ? "live" : ""}`} title={formatInput(tool.input)}>
      {live && <span className="chip-pulse" />}
      {tool.name}
      <span className="chip-arg">{summarizeInput(tool.input)}</span>
    </span>
  );
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const key = ["command", "file_path", "path", "pattern", "query", "url", "target", "text"].find((k) => k in obj);
    if (key) return String(obj[key]).slice(0, 60);
  }
  return "";
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
