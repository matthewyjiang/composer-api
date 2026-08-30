export interface CursorImage {
  url?: string;
  data?: string;
  mimeType?: string;
  dimension?: { width: number; height: number };
  uuid?: string;
}

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Bridge-generated MCP call id, reused as the OpenAI function_call call_id. */
  id?: string;
}

export type CursorTextEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: CursorToolCall }
  | { type: "rejected_tool_call"; toolCall: CursorToolCall; reason?: string }
  | { type: "done"; finalText: string; toolCalls: CursorToolCall[] };
