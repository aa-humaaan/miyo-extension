// Adapter registry. New sites are added by:
//   1. Writing src/adapters/<site>.ts that exports a `SiteAdapter`
//   2. Importing it here and adding it to ADAPTERS

import { chatgptAdapter } from './chatgpt.js';
import { claudeAdapter } from './claude.js';
import { geminiAdapter } from './gemini.js';
import { grokAdapter } from './grok.js';
import type { SiteAdapter, SiteId } from '../framework/types.js';

export const ADAPTERS: SiteAdapter[] = [chatgptAdapter, claudeAdapter, geminiAdapter, grokAdapter];

export function getAdapter(id: SiteId): SiteAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}
