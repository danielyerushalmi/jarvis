import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ClientEvent,
  ImageInput,
  ModelOption,
  PermissionPrompt,
  ServerEvent,
  ToolCall,
} from "./types";
import { cancelSpeech, speak, warmupTts } from "./voice";
import { withToken } from "./api";

export type Status = "connecting" | "ready" | "thinking";

export type JarvisState = {
  status: Status;
  model: string | null;
  models: ModelOption[];
  messages: ChatMessage[];
  streamingText: string; // live token preview for the in-flight assistant turn
  turnTools: ToolCall[]; // tools used in the current turn (activity strip)
  permission: PermissionPrompt | null;
  /** Cumulative cost of this run (the SDK reports a session running total, not per-turn). */
  costUsd: number | null;
  /** Cost added by the most recent turn, derived from the running total. */
  lastTurnCostUsd: number | null;
  ttsEnabled: boolean;
  /** Increments each time the global hotkey fires, so the UI can react. */
  hotkeySignal: number;
  send: (text: string, images?: ImageInput[]) => void;
  respondPermission: (id: string, approved: boolean) => void;
  setModel: (value: string) => void;
  interruptTurn: () => void;
  toggleTts: () => void;
  newChat: () => void;
};

const STORAGE_KEY = "jarvis.v1";

type Persisted = { sessionId: string | null; messages: ChatMessage[] };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessionId: null, messages: [] };
    const parsed = JSON.parse(raw) as Persisted;
    return { sessionId: parsed.sessionId ?? null, messages: parsed.messages ?? [] };
  } catch {
    return { sessionId: null, messages: [] };
  }
}

export function useJarvis(): JarvisState {
  const initial = useRef<Persisted>(loadPersisted()).current;

  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [model, setModelState] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages);
  const [streamingText, setStreamingText] = useState("");
  const [turnTools, setTurnTools] = useState<ToolCall[]>([]);
  // A queue, not a single slot: the agent can request approval for several
  // (parallel) tool calls at once. We show them one at a time; without the queue
  // a second request would overwrite the first, whose promise then hangs forever.
  const [permissionQueue, setPermissionQueue] = useState<PermissionPrompt[]>([]);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [lastTurnCostUsd, setLastTurnCostUsd] = useState<number | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [hotkeySignal, setHotkeySignal] = useState(0);

  // Running total last seen, so we can derive each turn's incremental cost.
  const costRef = useRef(0);

  // TTS state kept in refs so socket handlers read current values.
  const ttsRef = useRef(false);
  const spokenRef = useRef(0); // chars of the current turn already spoken

  // Source of truth for the in-flight streaming buffer + session id, kept in
  // refs so async handlers read current values without stale closures.
  const streamRef = useRef("");
  const sessionIdRef = useRef<string | null>(initial.sessionId);
  const messagesRef = useRef<ChatMessage[]>(initial.messages);

  const setStream = useCallback((text: string) => {
    streamRef.current = text;
    setStreamingText(text);
  }, []);

  // Speak complete sentences as they stream in, so Jarvis talks while it thinks
  // rather than waiting for the whole message.
  const speakNewSentences = useCallback((full: string) => {
    if (!ttsRef.current) return;
    const pending = full.slice(spokenRef.current);
    const match = pending.match(/^[\s\S]*[.!?…](?=\s|$)/);
    if (match && match[0].trim()) {
      speak(match[0]);
      spokenRef.current += match[0].length;
    }
  }, []);

  // Speak whatever is left of a finished message, then reset for the next turn.
  const speakTail = useCallback((full: string) => {
    if (ttsRef.current) {
      const pending = full.slice(spokenRef.current);
      if (pending.trim()) speak(pending);
    }
    spokenRef.current = 0;
  }, []);

  // Persist the displayable transcript + session id together.
  const persist = useCallback(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sessionId: sessionIdRef.current, messages: messagesRef.current } satisfies Persisted),
      );
    } catch {
      /* storage full / disabled — non-fatal */
    }
  }, []);

  const pushMessage = useCallback(
    (msg: ChatMessage) => {
      messagesRef.current = [...messagesRef.current, msg];
      setMessages(messagesRef.current);
      persist();
    },
    [persist],
  );

  useEffect(() => {
    let closed = false; // set on unmount so we stop reconnecting
    let retry = 0;
    let everOpened = false; // distinguishes "rejected" from "dropped"
    let authHinted = false; // the token hint is shown at most once
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // Resume the same SDK session on reconnect so a backend restart doesn't
      // lose the conversation.
      const resume = sessionIdRef.current ? `?resume=${encodeURIComponent(sessionIdRef.current)}` : "";
      // withToken() is a no-op in local dev — the Vite proxy supplies the header.
      // It matters when the browser talks to the backend directly, since a
      // WebSocket can't carry an Authorization header.
      const ws = new WebSocket(withToken(`${proto}://${location.host}/ws${resume}`));
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        everOpened = true;
        setStatus("ready");
      };
      ws.onclose = () => {
        setStatus("connecting");
        if (closed) return;
        // A socket that has NEVER opened, repeatedly, is usually a rejected
        // handshake rather than a backend that's down — and the most likely
        // reason is a missing token. Say so once; the browser doesn't expose the
        // 401 to us, so silence here reads as "Jarvis is broken".
        if (!everOpened && retry === 2 && !authHinted) {
          authHinted = true;
          pushMessage({
            role: "assistant",
            text:
              "⚠️ Can't connect to the backend. If you're reaching Jarvis directly (not through the dev server), " +
              "open the tokenized URL printed in its startup log — look for the `[auth] direct URL` line.",
            tools: [],
          });
        }
        // Reconnect with exponential backoff (capped) so a dropped backend
        // reconnects on its own instead of stranding the UI on "down".
        const delay = Math.min(1000 * 2 ** retry, 10_000);
        retry++;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => setStatus("connecting");

      ws.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as ServerEvent;
      switch (event.type) {
        case "session":
          setModelState(event.model);
          sessionIdRef.current = event.sessionId;
          persist();
          break;
        case "models":
          setModels(event.models);
          setModelState(event.current);
          break;
        case "model":
          setModelState(event.model);
          break;
        case "hotkey":
          setHotkeySignal((n) => n + 1);
          break;
        case "proactive":
          // Jarvis started this turn itself — mark it so the reply that follows
          // doesn't look like it came out of nowhere.
          pushMessage({ role: "system", text: event.label });
          setStatus("thinking");
          break;
        case "assistant_delta":
          setStream(streamRef.current + event.text);
          speakNewSentences(streamRef.current);
          break;
        case "assistant":
          if (event.tools.length) setTurnTools((prev) => mergeTools(prev, event.tools));
          if (event.text) {
            pushMessage({ role: "assistant", text: event.text, tools: event.tools });
            speakTail(event.text);
            setStream("");
          }
          break;
        case "result":
          // total_cost_usd is the session running total (measured), so take it
          // as-is and derive the per-turn delta rather than summing.
          if (typeof event.costUsd === "number") {
            const delta = event.costUsd - costRef.current;
            costRef.current = event.costUsd;
            setCostUsd(event.costUsd);
            setLastTurnCostUsd(delta > 0 ? delta : null);
          }
          break;
        case "permission_request": {
          const prompt: PermissionPrompt = {
            id: event.id,
            toolName: event.toolName,
            input: event.input,
            reason: event.reason,
            title: event.title,
            displayName: event.displayName,
            description: event.description,
          };
          setPermissionQueue((q) => (q.some((p) => p.id === prompt.id) ? q : [...q, prompt]));
          break;
        }
        case "error":
          pushMessage({ role: "assistant", text: `⚠️ ${event.error}`, tools: [] });
          break;
        case "turn_end":
          setStatus("ready");
          if (streamRef.current) {
            pushMessage({ role: "assistant", text: streamRef.current, tools: [] });
            speakTail(streamRef.current);
          }
          spokenRef.current = 0;
          setStream("");
          setTurnTools([]);
          break;
      }
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [persist, pushMessage, setStream, speakNewSentences, speakTail]);

  const emit = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  const send = useCallback(
    (text: string, images: ImageInput[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      cancelSpeech(); // barge-in: new input stops Jarvis mid-sentence
      spokenRef.current = 0;
      pushMessage({ role: "user", text: trimmed || "(look)", sawImage: images.length > 0 });
      setStatus("thinking");
      setTurnTools([]);
      setStream("");
      emit({ type: "user_message", text: trimmed, images: images.length ? images : undefined });
    },
    [emit, pushMessage, setStream],
  );

  const respondPermission = useCallback(
    (id: string, approved: boolean) => {
      setPermissionQueue((q) => q.filter((p) => p.id !== id));
      emit({ type: "permission_response", id, approved });
    },
    [emit],
  );

  const setModel = useCallback(
    (value: string) => {
      setModelState(value); // optimistic; server confirms with a "model" event
      emit({ type: "set_model", model: value });
    },
    [emit],
  );

  const interruptTurn = useCallback(() => {
    cancelSpeech();
    spokenRef.current = 0;
    emit({ type: "interrupt" });
  }, [emit]);

  const toggleTts = useCallback(() => {
    setTtsEnabled((on) => {
      const next = !on;
      ttsRef.current = next;
      if (next) warmupTts(); // start loading the neural voice so the first line isn't slow
      else cancelSpeech();
      return next;
    });
  }, []);

  const newChat = useCallback(() => {
    cancelSpeech();
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }, []);

  return {
    status,
    model,
    models,
    messages,
    streamingText,
    turnTools,
    costUsd,
    lastTurnCostUsd,
    ttsEnabled,
    hotkeySignal,
    permission: permissionQueue[0] ?? null, // show one at a time; rest wait in the queue
    send,
    respondPermission,
    setModel,
    interruptTurn,
    toggleTts,
    newChat,
  };
}

function mergeTools(prev: ToolCall[], next: ToolCall[]): ToolCall[] {
  const seen = new Set(prev.map((t) => t.id));
  return [...prev, ...next.filter((t) => !seen.has(t.id))];
}
