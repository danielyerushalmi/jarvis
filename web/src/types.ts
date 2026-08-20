// Mirrors the backend OutEvent union (server/src/agent.ts). Kept in sync by hand.
export type ToolCall = { id: string; name: string; input: unknown };

export type ModelOption = { value: string; label: string };

export type ServerEvent =
  | { type: "session"; sessionId: string; model: string }
  | { type: "models"; models: ModelOption[]; current: string }
  | { type: "model"; model: string }
  | { type: "proactive"; label: string }
  | { type: "hotkey" }
  | { type: "assistant"; text: string; tools: ToolCall[] }
  | { type: "assistant_delta"; text: string } // token stream (added in step 4)
  | { type: "result"; subtype: string; result?: string; costUsd?: number }
  | {
      type: "permission_request";
      id: string;
      toolName: string;
      input: unknown;
      reason?: string;
      title?: string;
      displayName?: string;
      description?: string;
    }
  | { type: "error"; error: string }
  | { type: "turn_end" };

export type ImageInput = { mediaType: string; data: string };

export type ClientEvent =
  | { type: "user_message"; text: string; images?: ImageInput[] }
  | { type: "permission_response"; id: string; approved: boolean; message?: string }
  | { type: "set_model"; model: string }
  | { type: "interrupt" };

export type PermissionPrompt = {
  id: string;
  toolName: string;
  input: unknown;
  reason?: string;
  title?: string;
  displayName?: string;
  description?: string;
};

export type ChatMessage =
  | { role: "user"; text: string; sawImage?: boolean }
  | { role: "assistant"; text: string; tools: ToolCall[] }
  /** A turn Jarvis started on its own (fired reminder, ambient trigger). */
  | { role: "system"; text: string };
