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

test('Gemini conversation parser reads candidate text and reverses newest-first turns', () => {
  const older = [
    ['meta', 'reply-older'],
    null,
    [['Question from user']],
    [[['candidate-older', ['Answer from Gemini'], null, null, null, null, null, null, [2]]]],
    [1_780_000_000, 0],
  ];
  const newer = [
    ['meta', 'reply-newer'],
    null,
    [['Second question']],
    [[['candidate-newer', ['Second answer'], null, null, null, null, null, null, [2]]]],
    [1_780_000_100, 0],
  ];
  const conversation = parseGeminiConversation('c_abc123', [[newer, older]]);
  assert.equal(conversation.conversation_id, 'c_abc123');
  assert.deepEqual(conversation.messages.map((m) => [m.role, m.text]), [
    ['user', 'Question from user'],
    ['assistant', 'Answer from Gemini'],
    ['user', 'Second question'],
    ['assistant', 'Second answer'],
  ]);
});

test('Gemini conversation parser refuses unfinished model responses', () => {
  const turn = [
    ['meta', 'reply-running'],
    null,
    [['Question']],
    [[['candidate-running', ['Partial answer'], null, null, null, null, null, null, [1]]]],
    [1_780_000_000, 0],
  ];
  assert.throws(
    () => parseGeminiConversation('c_running', [[turn]]),
    /not finalized/
  );
});

test('Grok list parser maps modify timestamp and next token', () => {
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

test('Grok detail joins response graph to loaded response bodies', () => {
  const conversation = parseGrokConversation('grok-1', {
    conversationId: 'grok-1',
    title: 'Test conversation',
    responseNodes: [
      { responseId: 'user-1', sender: 'human', parentResponseId: null },
      { responseId: 'assistant-1', sender: 'assistant', parentResponseId: 'user-1' },
    ],
    inflightResponses: [],
    responses: [
      { responseId: 'user-1', sender: 'human', query: 'Hello Grok', createTime: '2026-06-02T10:00:00.000Z' },
      { responseId: 'assistant-1', sender: 'assistant', message: 'Hello there', createTime: '2026-06-02T10:00:05.000Z' },
    ],
  });
  assert.deepEqual(conversation.messages.map((m) => [m.role, m.text]), [
    ['user', 'Hello Grok'],
    ['assistant', 'Hello there'],
  ]);
});

test('Grok detail refuses in-flight and missing response bodies', () => {
  assert.throws(() => parseGrokConversation('grok-2', {
    responseNodes: [{ responseId: 'pending', sender: 'assistant', parentResponseId: null }],
    inflightResponses: ['pending'],
    responses: [],
  }), /still generating/);

  assert.throws(() => parseGrokConversation('grok-3', {
    responseNodes: [{ responseId: 'missing', sender: 'assistant', parentResponseId: null }],
    inflightResponses: [],
    responses: [],
  }), /body missing/);
});
