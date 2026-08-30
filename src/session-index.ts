import { canonicalizeItem, matchTranscriptPrefix, responseInputItems } from "./transcript-prefix.js";

const SEEN_SESSION_LIMIT = 2048;
// Rho-style clients replay the whole transcript every request; a 200k-token
// session is ~1 MiB of JSON. The old 256 KiB cap silently disabled prefix
// matching (and so prompt caching) exactly when sessions grew long enough for
// caching to matter. Bound per-entry size generously and enforce a global
// budget with LRU eviction instead.
const MAX_STORED_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

export interface SessionPrefixMatch {
  sessionKey: string;
  inputItems: unknown[];
  outputItems: unknown[];
}

interface SessionIndexEntry {
  ownerKey: string;
  sessionKey: string;
  inputItems: unknown[];
  outputItems: unknown[];
  updatedAt: number;
  bytes: number;
}

const seenSessionKeys = new Set<string>();
const entriesByFirstItem = new Map<string, SessionIndexEntry[]>();
// Insertion-ordered LRU over every stored entry; re-set on update.
const entriesBySessionKey = new Map<string, SessionIndexEntry>();
let totalTranscriptBytes = 0;

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

export function rememberPrefixSession(input: {
  ownerKey: string;
  sessionKey: string;
  inputItems: unknown[];
  outputItems: unknown[];
  updatedAt: number;
}) {
  const bytes = transcriptBytes(input.inputItems, input.outputItems);
  if (bytes > MAX_STORED_TRANSCRIPT_BYTES) return;
  if (!input.inputItems.length) return;
  dropSessionEntry(input.sessionKey);
  const entry: SessionIndexEntry = {
    ownerKey: input.ownerKey,
    sessionKey: input.sessionKey,
    inputItems: input.inputItems,
    outputItems: input.outputItems,
    updatedAt: input.updatedAt,
    bytes
  };
  const key = bucketKey(input.ownerKey, canonicalizeItem(entry.inputItems[0]));
  const bucket = entriesByFirstItem.get(key) ?? [];
  bucket.push(entry);
  entriesByFirstItem.set(key, bucket);
  entriesBySessionKey.set(entry.sessionKey, entry);
  totalTranscriptBytes += bytes;
  evictOverBudget();
}

export function matchPrefixSession(ownerKey: string | undefined, input: unknown): SessionPrefixMatch | undefined {
  if (!ownerKey) return undefined;
  const currentItems = responseInputItems(input);
  if (!currentItems.length) return undefined;
  const first = canonicalizeItem(currentItems[0]);
  const bucket = entriesByFirstItem.get(bucketKey(ownerKey, first)) ?? [];
  let best: (SessionPrefixMatch & { updatedAt: number }) | undefined;
  for (const stored of bucket) {
    const match = matchTranscriptPrefix(currentItems, stored.inputItems, stored.outputItems);
    if (!match.matched) continue;
    if (!best || stored.updatedAt > best.updatedAt) {
      best = {
        sessionKey: stored.sessionKey,
        inputItems: stored.inputItems,
        outputItems: stored.outputItems,
        updatedAt: stored.updatedAt
      };
    }
  }
  if (!best) return undefined;
  return {
    sessionKey: best.sessionKey,
    inputItems: best.inputItems,
    outputItems: best.outputItems
  };
}

/**
 * Stored transcript for an exact session key (client-provided affinity such as
 * a Responses prompt_cache_key). Returned only when the stored transcript is a
 * prefix of the current input, so callers can safely treat leftover items as
 * the delta.
 */
export function sessionTranscript(ownerKey: string, sessionKey: string, input: unknown): SessionPrefixMatch | undefined {
  const stored = entriesBySessionKey.get(sessionKey);
  if (!stored || stored.ownerKey !== ownerKey) return undefined;
  const currentItems = responseInputItems(input);
  if (!currentItems.length) return undefined;
  const match = matchTranscriptPrefix(currentItems, stored.inputItems, stored.outputItems);
  if (!match.matched) return undefined;
  return {
    sessionKey: stored.sessionKey,
    inputItems: stored.inputItems,
    outputItems: stored.outputItems
  };
}

export function resetSessionIndex() {
  seenSessionKeys.clear();
  entriesByFirstItem.clear();
  entriesBySessionKey.clear();
  totalTranscriptBytes = 0;
}

export function boundedTranscriptItems(items: unknown[]): unknown[] {
  const json = JSON.stringify(items);
  if (Buffer.byteLength(json) <= MAX_STORED_TRANSCRIPT_BYTES) return items;
  return [];
}

function transcriptBytes(inputItems: unknown[], outputItems: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(inputItems)) + Buffer.byteLength(JSON.stringify(outputItems));
}

function dropSessionEntry(sessionKey: string) {
  const existing = entriesBySessionKey.get(sessionKey);
  if (!existing) return;
  entriesBySessionKey.delete(sessionKey);
  totalTranscriptBytes -= existing.bytes;
  const key = bucketKey(existing.ownerKey, canonicalizeItem(existing.inputItems[0]));
  const bucket = entriesByFirstItem.get(key);
  if (!bucket) return;
  const next = bucket.filter((candidate) => candidate !== existing);
  if (next.length) entriesByFirstItem.set(key, next);
  else entriesByFirstItem.delete(key);
}

function evictOverBudget() {
  while (totalTranscriptBytes > MAX_TOTAL_TRANSCRIPT_BYTES) {
    const oldest = entriesBySessionKey.values().next().value;
    if (!oldest) {
      totalTranscriptBytes = 0;
      return;
    }
    dropSessionEntry(oldest.sessionKey);
  }
}

function bucketKey(ownerKey: string, firstItem: unknown): string {
  return `${ownerKey}:${JSON.stringify(firstItem)}`;
}
