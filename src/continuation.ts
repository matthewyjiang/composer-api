export const CONTINUATION_PREAMBLE =
  "This Cursor session already has the earlier conversation. Continue from this new input only:";

export function continuationFromBody(body: string | undefined): string | undefined {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return undefined;
  return `${CONTINUATION_PREAMBLE}\n\n${text}`;
}

export function messagesAfterLastAssistant(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    if (isRecord(item) && item.role === "assistant") start = index + 1;
  }
  if (start === 0 || start >= messages.length) return [];
  return messages.slice(start);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
