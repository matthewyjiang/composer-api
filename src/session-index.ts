const SEEN_SESSION_LIMIT = 2048;
const MAX_STORED_TRANSCRIPT_BYTES = 256 * 1024;

export interface SessionPrefixMatch {
  sessionKey: string;
  newInputItems: unknown[];
  inputItems: unknown[];
  outputItems: unknown[];
}

export interface TranscriptLeftover {
  leftover: unknown[];
  matched: boolean;
}

interface SessionIndexEntry {
  ownerKey: string;
  sessionKey: string;
  inputItems: unknown[];
  outputItems: unknown[];
  updatedAt: number;
}

const seenSessionKeys = new Set<string>();
const entriesByFirstItem = new Map<string, SessionIndexEntry[]>();

export function touchSessionKey(sessionKey: string) {
  if (seenSessionKeys.has(sessionKey)) {
    seenSessionKeys.delete(sessionKey);
    seenSessionKeys.add(sessionKey);
    return;
  }
  seenSessionKeys.add(sessionKey);
  if (seenSessionKeys.size <= SEEN_SESSION_LIMIT) return;
  const oldest = seenSessionKeys.values().next().value;
  if (oldest) seenSessionKeys.delete(oldest);
}

export function hasSessionKey(sessionKey: string): boolean {
  return seenSessionKeys.has(sessionKey);
}

export function rememberPrefixSession(input: {
  ownerKey: string;
  sessionKey: string;
  inputItems: unknown[];
  outputItems: unknown[];
  updatedAt: number;
}) {
  const inputItems = boundedTranscriptItems(input.inputItems);
  const outputItems = boundedTranscriptItems(input.outputItems);
  if (!inputItems.length) return;
  const entry: SessionIndexEntry = {
    ownerKey: input.ownerKey,
    sessionKey: input.sessionKey,
    inputItems,
    outputItems,
    updatedAt: input.updatedAt
  };
  const key = bucketKey(input.ownerKey, canonicalizeItem(entry.inputItems[0]));
  const bucket = entriesByFirstItem.get(key) ?? [];
  const next = bucket.filter((candidate) => candidate.sessionKey !== entry.sessionKey);
  next.push(entry);
  entriesByFirstItem.set(key, next);
}

/**
 * Current input relative to a stored Responses transcript.
 * Full prefix: client replayed input+output.
 * Input prefix: client replayed input and reattached stored function_calls.
 * No prefix: treat current as a delta (OpenAI previous_response_id contract).
 */
export function matchTranscriptPrefix(
  currentItems: unknown[],
  storedInput: unknown[] = [],
  storedOutput: unknown[] = []
): TranscriptLeftover {
  if (!currentItems.length) {
    return { leftover: [], matched: storedInput.length + storedOutput.length > 0 };
  }
  const current = canonicalizeItems(currentItems);
  const full = canonicalizeItems([...storedInput, ...storedOutput]);
  const inputOnly = canonicalizeItems(storedInput);
  if (full.length && isItemPrefix(full, current)) {
    return { leftover: currentItems.slice(full.length), matched: true };
  }
  if (inputOnly.length && isItemPrefix(inputOnly, current)) {
    const functionCalls = canonicalizeItems(storedOutput).filter(isFunctionCall);
    const leftover = currentItems.slice(inputOnly.length).filter((item) => {
      const canonical = canonicalizeItem(item);
      return !functionCalls.some((call) => itemsEqual(canonical, call));
    });
    return { leftover, matched: true };
  }
  return { leftover: currentItems, matched: false };
}

export function leftoverAfterTranscript(
  currentItems: unknown[],
  storedInput: unknown[] = [],
  storedOutput: unknown[] = []
): unknown[] {
  return matchTranscriptPrefix(currentItems, storedInput, storedOutput).leftover;
}

export function matchPrefixSession(ownerKey: string | undefined, currentItems: unknown[]): SessionPrefixMatch | undefined {
  if (!ownerKey) return undefined;
  const current = canonicalizeItems(currentItems);
  if (!current.length) return undefined;
  const bucket = entriesByFirstItem.get(bucketKey(ownerKey, current[0])) ?? [];
  let best: (SessionPrefixMatch & { updatedAt: number }) | undefined;
  for (const stored of bucket) {
    const match = matchTranscriptPrefix(currentItems, stored.inputItems, stored.outputItems);
    if (!match.matched) continue;
    if (!best || stored.updatedAt > best.updatedAt) {
      best = {
        sessionKey: stored.sessionKey,
        newInputItems: match.leftover,
        inputItems: stored.inputItems,
        outputItems: stored.outputItems,
        updatedAt: stored.updatedAt
      };
    }
  }
  if (!best) return undefined;
  return {
    sessionKey: best.sessionKey,
    newInputItems: best.newInputItems,
    inputItems: best.inputItems,
    outputItems: best.outputItems
  };
}

export function resetSessionIndex() {
  seenSessionKeys.clear();
  entriesByFirstItem.clear();
}

export function boundedTranscriptItems(items: unknown[]): unknown[] {
  const json = JSON.stringify(items);
  if (Buffer.byteLength(json) <= MAX_STORED_TRANSCRIPT_BYTES) return items;
  return [];
}

function isItemPrefix(prefix: unknown[], current: unknown[]): boolean {
  if (current.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (!itemsEqual(prefix[index], current[index])) return false;
  }
  return true;
}

function canonicalizeItems(items: unknown[]): unknown[] {
  return items.map(canonicalizeItem);
}

function canonicalizeItem(item: unknown): unknown {
  if (typeof item === "string") return { type: "message", role: "user", text: item };
  if (!isRecord(item)) return item;
  const type = typeof item.type === "string" ? item.type : typeof item.role === "string" ? "message" : "unknown";
  if (type === "input_text" && typeof item.text === "string") {
    return { type: "message", role: "user", text: item.text };
  }
  if (type === "message" || typeof item.role === "string") {
    return {
      type: "message",
      role: typeof item.role === "string" ? item.role : "user",
      text: contentTextForPrefix(item.content)
    };
  }
  if (type === "function_call") {
    return {
      type: "function_call",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
    };
  }
  if (type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
    };
  }
  return { type, value: item };
}

function isFunctionCall(item: unknown): boolean {
  return isRecord(item) && item.type === "function_call";
}

function contentTextForPrefix(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (isRecord(part) && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function bucketKey(ownerKey: string, firstItem: unknown): string {
  return `${ownerKey}:${JSON.stringify(firstItem)}`;
}

function itemsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
