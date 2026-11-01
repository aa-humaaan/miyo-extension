// Gemini web-history adapter for Miyo Capture.
//
// Uses Gemini's authenticated batchexecute RPCs from the extension worker.
// These are undocumented, versioned web-app internals. Keep parsing isolated
// here and fail loudly when Google's response shape changes; never silently
// report a partial history as complete.

import type { ChatConversation, ChatMessage } from '../framework/chat.js';
import type { ChatSiteAdapter, ItemListPage, SiteSession } from '../framework/types.js';
import { classifyHttp } from '../framework/rate-limit.js';

const GEMINI = 'https://gemini.google.com';
const APP_URL = `${GEMINI}/app`;
const BATCH_URL = `${GEMINI}/_/BardChatUi/data/batchexecute`;
const LIST_RPC = 'MaZiqc';
const READ_RPC = 'hNvQHb';
const PAGE_SIZE = 100;
const MAX_TURNS_PER_CONVERSATION = 10_000;
const MAX_FRAME_CHARS = 20_000_000;

interface GeminiSession {
  token: string;
  buildLabel: string;
  sessionId: string;
  expiresAt: number;
}
interface GeminiListPage {
  items: Array<{ id: string; title: string; updated_at: string }>;
  next_cursor: string | null;
}
let sessionCache: GeminiSession | null = null;
let requestId = 100_000;
const titleCache = new Map<string, string>();
const updatedAtCache = new Map<string, string>();

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function atPath(value: unknown, path: number[]): unknown {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  return '';
}
function toIso(value: unknown): string | null {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    const seconds = value[0];
    const nanos = typeof value[1] === 'number' ? value[1] : 0;
    const date = new Date(seconds * 1000 + nanos / 1_000_000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function parseFrames(raw: string): unknown[] {
  const text = raw.replace(/^\)\]\}'[^\n]*\n?/, '');
  const frames: unknown[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text[offset] ?? '')) offset++;
    if (offset >= text.length) break;
    const newline = text.indexOf('\n', offset);
    if (newline !== -1) {
      const header = text.slice(offset, newline).trim();
      if (/^\d+$/.test(header)) {
        const size = Number(header);
        const start = newline + 1;
        const end = start + size;
        if (size > 0 && size <= MAX_FRAME_CHARS && end <= text.length) {
          try {
            frames.push(JSON.parse(text.slice(start, end)) as unknown);
            offset = end;
            continue;
          } catch { /* try line frame below */ }
        }
      }
    }
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd).trim();
    if (line) {
      try { frames.push(JSON.parse(line) as unknown); } catch { /* ignore diagnostics */ }
    }
    offset = lineEnd + 1;
  }
  return frames;
}
function findRpcPayload(value: unknown, rpcId: string): unknown | null {
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!Array.isArray(current)) continue;
    if (current.some((part) => part === rpcId)) {
      const encoded = current.find((part) =>
        typeof part === 'string' && part.startsWith('[') && part.endsWith(']')
      );
      if (typeof encoded === 'string') {
        try { return JSON.parse(encoded) as unknown; } catch { /* inspect next candidate */ }
      }
    }
    for (const child of current) if (Array.isArray(child)) stack.push(child);
  }
  return null;
}

export function parseGeminiListPayload(payload: unknown): GeminiListPage {
  const outer = asArray(payload);
  const next = typeof outer[1] === 'string' && outer[1] !== '' ? outer[1] : null;
  const rows = asArray(outer[2]);
  const items: GeminiListPage['items'] = [];
  for (const rowValue of rows) {
    const row = asArray(rowValue);
    const id = typeof row[0] === 'string' ? row[0] : '';
    if (!id) continue;
    const title = typeof row[1] === 'string' && row[1].trim()
      ? row[1].trim() : 'Untitled Gemini conversation';
    const updatedAt = toIso(row[5]);
    if (!updatedAt) {
      throw new Error(`Gemini conversation ${id} has no valid update timestamp; refusing to skip it`);
    }
    items.push({ id, title, updated_at: updatedAt });
    titleCache.set(id, title);
    updatedAtCache.set(id, updatedAt);
  }
  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { items, next_cursor: next };
}

export function parseGeminiConversation(id: string, payload: unknown): ChatConversation {
  const outer = asArray(payload);
  const turns = asArray(outer[0]);
  if (turns.length >= MAX_TURNS_PER_CONVERSATION) {
    throw new Error(`Gemini conversation reached the ${MAX_TURNS_PER_CONVERSATION.toLocaleString()}-turn safety cap; refusing to export a possibly incomplete history`);
  }
  const messages: ChatMessage[] = [];

  // Gemini's web API returns turns newest-first. The stable shape used by
  // the current web client has user text at [2][0][0] and candidate arrays
  // at [3][0]. Candidate text is [1][0]; candidate status [8][0] == 2
  // denotes a completed generation. Ignore metadata-only candidates, but
  // fail closed if a non-empty turn has no readable prompt or answer.
  for (const turnValue of turns.slice().reverse()) {
    const turn = asArray(turnValue);
    const timestamp = null; // Gemini turn payloads do not expose a stable per-message timestamp.
    const userText = asText(atPath(turn, [2, 0, 0])).trim();
    if (userText) messages.push({ role: 'user', text: userText, created_at: timestamp });

    const candidates = asArray(atPath(turn, [3, 0]));
    const candidateTexts = candidates.flatMap((candidateValue) => {
      const candidate = asArray(candidateValue);
      const candidateText = asText(atPath(candidate, [1, 0])).trim();
      if (!candidateText) return [];
      const completionStatus = atPath(candidate, [8, 0]);
      if (completionStatus !== 2) {
        throw new Error('Gemini response is not finalized; wait for generation to finish and retry');
      }
      return [candidateText];
    });
    for (const answer of candidateTexts) {
      messages.push({ role: 'assistant', text: answer, created_at: timestamp });
    }

    if (!userText && candidateTexts.length === 0 && turn.length > 0) {
      // Some turns can be metadata-only; don't emit them.
      continue;
    }
  }

  if (turns.length > 0 && messages.length === 0) {
    throw new Error('Gemini returned turns but no readable message text; the provider response schema may have changed');
  }
  const updatedAt = updatedAtCache.get(id) ?? updatedAtCache.get(id.startsWith('c_') ? id : `c_${id}`) ?? null;
  const conversationId = id.startsWith('c_') ? id : `c_${id}`;
  return {
    site: 'gemini',
    conversation_id: conversationId,
    title: titleCache.get(id) ?? titleCache.get(conversationId) ?? 'Gemini conversation',
    url: `${GEMINI}/app/${encodeURIComponent(conversationId)}`,
    // Gemini's conversation detail payload does not expose a trustworthy creation timestamp.
    created_at: null,
    updated_at: updatedAt,
    messages,
  };
}

async function getSession(forceRefresh = false): Promise<GeminiSession> {
  if (!forceRefresh && sessionCache && Date.now() < sessionCache.expiresAt - 60_000) return sessionCache;
  const response = await fetch(APP_URL, {
    method: 'GET', credentials: 'include', headers: { accept: 'text/html' }, cache: 'no-store',
  });
  await classifyHttp(response, 'Gemini app session');
  if (response.redirected && new URL(response.url).hostname !== 'gemini.google.com') {
    throw new Error('Gemini redirected to sign-in; no active session in this browser');
  }
  const html = await response.text();
  const token = /"SNlM0e":"([^"\\]{1,512})"/.exec(html)?.[1];
  const buildLabel = /"cfb2h":"([^"\\]{1,256})"/.exec(html)?.[1];
  const sessionId = /"FdrFJe":"(-?\d{1,32})"/.exec(html)?.[1] ?? '';
  if (!token || !buildLabel) throw new Error('Gemini session tokens were not found; sign in or the page protocol may have changed');
  sessionCache = { token, buildLabel, sessionId, expiresAt: Date.now() + 4 * 60_000 };
  return sessionCache;
}

async function geminiRpc(rpcId: string, payload: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getSession(attempt > 0);
    const query = new URLSearchParams({
      rpcids: rpcId, 'source-path': '/app', bl: session.buildLabel, hl: 'en',
      _reqid: String(requestId), rt: 'c',
    });
    requestId += 100_000;
    if (session.sessionId) query.set('f.sid', session.sessionId);
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]),
      at: session.token,
    });
    const response = await fetch(`${BATCH_URL}?${query.toString()}`, {
      method: 'POST', credentials: 'include',
      headers: { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
      body: body.toString(), cache: 'no-store',
    });
    if ((response.status === 400 || response.status === 401) && attempt === 0) {
      sessionCache = null;
      continue;
    }
    await classifyHttp(response, `Gemini ${rpcId}`);
    const frames = parseFrames(await response.text());
    for (const frame of frames) {
      const found = findRpcPayload(frame, rpcId);
      if (found !== null) return found;
    }
    throw new Error(`Gemini ${rpcId} response did not contain the expected RPC payload`);
  }
  throw new Error('Gemini session expired; refresh Gemini and retry');
}

export const geminiAdapter: ChatSiteAdapter = {
  id: 'gemini',
  label: 'Gemini',
  home_url: APP_URL,
  brand_color: '#4285f4',
  kind: 'chat',
  async probeSession(): Promise<SiteSession> {
    try { await getSession(true); return { signedIn: true, email: null }; }
    catch { sessionCache = null; return { signedIn: false, email: null }; }
  },
  async listItems(cursor: string | null): Promise<ItemListPage> {
    // Gemini stores pinned and unpinned conversations in separate list
    // buckets. Walk both buckets and paginate each independently so the
    // archive does not silently omit pinned conversations.
    let state: { category: 0 | 1; token: string | null } = { category: 1, token: null };
    if (cursor) {
      try {
        const parsed = JSON.parse(cursor) as { category?: unknown; token?: unknown };
        if ((parsed.category === 0 || parsed.category === 1) &&
          (parsed.token === null || typeof parsed.token === 'string')) {
          state = { category: parsed.category, token: parsed.token as string | null };
        } else {
          throw new Error('invalid cursor');
        }
      } catch {
        throw new Error('Gemini pagination cursor is invalid; restart the capture');
      }
    }
    const page = parseGeminiListPayload(
      await geminiRpc(LIST_RPC, [PAGE_SIZE, state.token, [state.category, null, 1]])
    );
    let nextCursor: string | null = null;
    if (page.next_cursor) {
      nextCursor = JSON.stringify({ category: state.category, token: page.next_cursor });
    } else if (state.category === 1) {
      nextCursor = JSON.stringify({ category: 0, token: null });
    }
    return { items: page.items, next_cursor: nextCursor, total: null };
  },
  async fetchConversation(id: string): Promise<ChatConversation> {
    const normalizedId = id.startsWith('c_') ? id.slice(2) : id;
    const payload = await geminiRpc(READ_RPC, [`c_${normalizedId}`, 10, null, 1, [0], [4], null, 1]);
    return parseGeminiConversation(id, payload);
  },
};
