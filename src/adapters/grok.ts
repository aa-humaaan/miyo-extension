// Grok web-history adapter for Miyo Capture.
//
// Uses the signed-in Grok web app's conversation endpoints. These are
// undocumented web-app APIs; validate response shapes and fail closed when
// they change instead of exporting a misleading partial archive.

import type { ChatConversation, ChatMessage } from '../framework/chat.js';
import type { ChatSiteAdapter, ItemListPage, SiteSession } from '../framework/types.js';
import { classifyHttp } from '../framework/rate-limit.js';

const GROK = 'https://grok.com';
const PAGE_SIZE = 50;
const MAX_NODES = 2_000;

interface GrokListItem {
  conversationId?: string;
  id?: string;
  title?: string;
  createTime?: string;
  modifyTime?: string;
}
interface GrokListResponse {
  conversations?: GrokListItem[];
  items?: GrokListItem[];
  nextPageToken?: string | null;
}
interface GrokNode {
  responseId?: string;
  parentResponseId?: string | null;
  role?: string;
  message?: string;
  query?: string;
  content?: string;
  text?: string;
  createTime?: string | number;
  timestamp?: string | number;
}
interface GrokDetail {
  conversationId?: string;
  title?: string;
  responseNodes?: GrokNode[];
  responses?: GrokNode[];
}

function iso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'message']) {
      const found = textValue(obj[key]);
      if (found) return found;
    }
  }
  return '';
}
function listItems(raw: unknown): GrokListItem[] {
  if (Array.isArray(raw)) return raw as GrokListItem[];
  if (raw && typeof raw === 'object') {
    const obj = raw as GrokListResponse;
    if (Array.isArray(obj.conversations)) return obj.conversations;
    if (Array.isArray(obj.items)) return obj.items;
  }
  throw new Error('Grok conversation list had an unexpected response shape');
}
export function parseGrokListPayload(raw: unknown): ItemListPage {
  const rows = listItems(raw);
  const next = raw && typeof raw === 'object'
    ? (raw as GrokListResponse).nextPageToken ?? null
    : null;
  const items = rows.flatMap((row) => {
    const id = row.conversationId ?? row.id;
    const updated = iso(row.modifyTime ?? row.createTime);
    return id && updated ? [{ id, updated_at: updated }] : [];
  });
  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { items, next_cursor: next, total: null };
}

function roleOf(node: GrokNode): 'user' | 'assistant' | null {
  const role = (node.role ?? '').toLowerCase();
  if (['user', 'human'].includes(role)) return 'user';
  if (['assistant', 'model', 'grok'].includes(role)) return 'assistant';
  return null;
}
function flattenNodes(nodes: GrokNode[]): ChatMessage[] {
  if (nodes.length > MAX_NODES) {
    throw new Error(`Grok conversation exceeded the ${MAX_NODES} response-node safety cap`);
  }
  const byId = new Map(nodes.filter((n) => n.responseId).map((n) => [n.responseId!, n]));
  // The API may return a response graph with branches. Reconstruct the
  // best available active chain by following parent links from leaf nodes.
  const parents = new Set(nodes.map((n) => n.parentResponseId).filter((v): v is string => Boolean(v)));
  const leaves = nodes.filter((n) => n.responseId && !parents.has(n.responseId));
  const leaf = leaves[leaves.length - 1];
  let cursor: GrokNode | undefined = leaf;
  const chain: GrokNode[] = [];
  const seen = new Set<string>();
  while (cursor) {
    const id = cursor.responseId;
    if (id && seen.has(id)) break;
    if (id) seen.add(id);
    chain.push(cursor);
    cursor = cursor.parentResponseId ? byId.get(cursor.parentResponseId) : undefined;
  }
  if (!chain.length) return nodes.flatMap((n) => {
    const role = roleOf(n);
    const body = textValue(n.message || n.query || n.content || n.text).trim();
    return role && body ? [{ role, text: body, created_at: iso(n.createTime ?? n.timestamp) }] : [];
  });
  chain.reverse();
  return chain.flatMap((n) => {
    const role = roleOf(n);
    const body = textValue(role === 'user' ? (n.message || n.query) : (n.message || n.content || n.text)).trim();
    return role && body ? [{ role, text: body, created_at: iso(n.createTime ?? n.timestamp) }] : [];
  });
}
export function parseGrokConversation(id: string, raw: unknown): ChatConversation {
  if (!raw || typeof raw !== 'object') throw new Error('Grok conversation detail was not an object');
  const detail = raw as GrokDetail;
  const nodes = detail.responseNodes ?? detail.responses;
  if (!Array.isArray(nodes)) throw new Error('Grok detail response omitted responseNodes');
  const messages = flattenNodes(nodes);
  if (nodes.length && messages.length === 0) {
    throw new Error('Grok returned response nodes but no readable messages; the provider schema may have changed');
  }
  const times = messages.map((m) => m.created_at).filter((v): v is string => Boolean(v)).map(Date.parse).filter(Number.isFinite).sort((a,b)=>a-b);
  const conversationId = detail.conversationId ?? id;
  const createdAt = times.length ? new Date(times[0]!).toISOString() : null;
  const updatedAt = times.length ? new Date(times[times.length-1]!).toISOString() : createdAt;
  return {
    site: 'grok',
    conversation_id: conversationId,
    title: typeof detail.title === 'string' && detail.title.trim() ? detail.title.trim() : 'Grok conversation',
    url: `${GROK}/c/${encodeURIComponent(conversationId)}`,
    created_at: createdAt,
    updated_at: updatedAt,
    messages,
  };
}

async function grokApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GROK}${path}`, {
    ...init,
    credentials: 'include',
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  await classifyHttp(response, `Grok ${path}`);
  return await response.json() as T;
}
async function listPage(cursor: string | null): Promise<unknown> {
  const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
  if (cursor) query.set('pageToken', cursor);
  return grokApi(`/rest/app-chat/conversations?${query.toString()}`);
}
async function fetchDetail(id: string): Promise<unknown> {
  const detail = await grokApi<Record<string, unknown>>(
    `/rest/app-chat/conversations/${encodeURIComponent(id)}/response-node?includeThreads=true`
  );
  const responseIds = Array.isArray(detail.responseIds) ? detail.responseIds.filter((v): v is string => typeof v === 'string') : [];
  if (!responseIds.length) return detail;
  const loaded = await grokApi<unknown>('/rest/app-chat/conversations/load-responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: id, responseIds }),
  });
  if (loaded && typeof loaded === 'object') return { ...detail, ...(loaded as object) };
  throw new Error('Grok response loader returned an unexpected shape');
}

export const grokAdapter: ChatSiteAdapter = {
  id: 'grok',
  label: 'Grok',
  home_url: GROK,
  brand_color: '#111827',
  kind: 'chat',
  async probeSession(): Promise<SiteSession> {
    try {
      const raw = await listPage(null);
      // Empty conversation lists are valid for a signed-in new account.
      if (Array.isArray(raw)) return { signedIn: true, email: null };
      if (raw && typeof raw === 'object' &&
        (Array.isArray((raw as GrokListResponse).conversations) || Array.isArray((raw as GrokListResponse).items))) {
        return { signedIn: true, email: null };
      }
      return { signedIn: false, email: null };
    } catch {
      return { signedIn: false, email: null };
    }
  },
  async listItems(cursor: string | null): Promise<ItemListPage> {
    return parseGrokListPayload(await listPage(cursor));
  },
  async fetchConversation(id: string): Promise<ChatConversation> {
    return parseGrokConversation(id, await fetchDetail(id));
  },
};
