import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeminiListPayload, parseGeminiConversation } from './gemini.js';
import { parseGrokListPayload, parseGrokConversation } from './grok.js';

test('Gemini list parser preserves pagination token and timestamp', () => {
  const page = parseGeminiListPayload([
    null,
    'next-page-token',
    [['c_abc123', 'Gemini archive test', null, null, null, [1_780_000_000, 0]]],
  ]);
  assert.equal(page.next_cursor, 'next-page-token');
  assert.deepEqual(page.items, [{
    id: 'c_abc123',
    title: 'Gemini archive test',
    updated_at: '2026-05-28T20:26:40.000Z',
  }]);
});

test('Gemini conversation parser converts newest-first turns into chronological messages', () => {
  const turn = [
    ['meta'],
    ['meta'],
    [['Question from user']],
    [[['response-id', ['Answer from Gemini']]]],
    [1_780_000_000, 0],
  ];
  const conversation = parseGeminiConversation('c_abc123', [[turn]]);
  assert.equal(conversation.conversation_id, 'c_abc123');
  assert.deepEqual(conversation.messages.map((m) => [m.role, m.text]), [
    ['user', 'Question from user'],
    ['assistant', 'Answer from Gemini'],
  ]);
});

test('Grok list parser maps create/modify timestamps and next token', () => {
  const page = parseGrokListPayload({
    conversations: [{
      conversationId: 'grok-1',
      title: 'Grok archive test',
      createTime: '2026-06-02T10:00:00.000Z',
      modifyTime: '2026-06-02T10:05:00.000Z',
    }],
    nextPageToken: 'cursor-2',
  });
  assert.equal(page.next_cursor, 'cursor-2');
  assert.deepEqual(page.items, [{
    id: 'grok-1', updated_at: '2026-06-02T10:05:00.000Z',
  }]);
});

test('Grok detail parser follows the active response path and maps user/assistant roles', () => {
  const conversation = parseGrokConversation('grok-1', {
    conversationId: 'grok-1',
    title: 'Test conversation',
    responseNodes: [
      { responseId: 'user-1', role: 'human', parentResponseId: null, query: 'Hello Grok' },
      { responseId: 'assistant-1', role: 'assistant', parentResponseId: 'user-1', message: 'Hello there' },
    ],
  });
  assert.deepEqual(conversation.messages.map((m) => [m.role, m.text]), [
    ['user', 'Hello Grok'],
    ['assistant', 'Hello there'],
  ]);
});
