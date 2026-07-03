'use strict';

const { createGraphClient } = require('../src/graph/graphClient');

const tokenProvider = { async getToken() { return 'tok'; } };

/** Build a fake fetch that dispatches by URL substring and can script statuses. */
function makeFetch(handlers) {
  const calls = {};
  const impl = async (url) => {
    // Longest match wins so "/messages" isn't captured by "/me".
    const key = Object.keys(handlers)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    calls[key] = (calls[key] || 0) + 1;
    const seq = handlers[key];
    const step = Array.isArray(seq) ? seq[Math.min(calls[key] - 1, seq.length - 1)] : seq;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (h) => (step.headers ? step.headers[h] : null) },
      async json() { return step.body; },
      async text() { return JSON.stringify(step.body || ''); },
    };
  };
  impl.calls = calls;
  return impl;
}

/** Shorthand for a chat whose lastMessagePreview is `preview`. */
const chat = (id, preview) => ({ id, lastMessagePreview: preview });
const msg = (id, userId, content, ts) => ({
  id,
  messageType: 'message',
  from: { user: { id: userId } },
  createdDateTime: ts,
  body: { content },
});

describe('graphClient.getAllMessagesSince', () => {
  test('returns the last human reply per chat, filtering system/bot/empty', async () => {
    const fetchImpl = makeFetch({
      '/me?$select=id': { status: 200, body: { id: 'BOT' } },
      '/me/chats': {
        status: 200,
        body: {
          value: [
            chat('c1', msg('r1', 'U1', 'B', '2030-01-01T00:00:03.000Z')), // real reply
            chat('c2', msg('r2', 'U2', 'A', '2030-01-01T00:00:04.000Z')), // real reply
            chat('c3', msg('m1', 'BOT', '<b>Question 1</b>', '2030-01-01T00:00:02.000Z')), // bot's own message
            chat('c4', { id: 's1', messageType: 'systemEventMessage', from: null, createdDateTime: '2030-01-01T00:00:01.000Z', body: { content: '' } }), // system event
            chat('c5', msg('r3', 'U3', '', '2030-01-01T00:00:05.000Z')), // empty / attachment-only
            chat('c6', null), // no messages yet
          ],
        },
      },
    });
    const client = createGraphClient({ tokenProvider, fetchImpl });

    const msgs = await client.getAllMessagesSince(null);
    expect(msgs.map((m) => [m.chatId, m.text])).toEqual([
      ['c1', 'B'],
      ['c2', 'A'],
    ]);
  });

  test('drops replies at or before the sinceIso watermark', async () => {
    const fetchImpl = makeFetch({
      '/me?$select=id': { status: 200, body: { id: 'BOT' } },
      '/me/chats': {
        status: 200,
        body: {
          value: [
            chat('old', msg('a', 'U', 'A', '2030-01-01T00:00:01.000Z')),
            chat('new', msg('c', 'U', 'C', '2030-01-01T00:00:09.000Z')),
          ],
        },
      },
    });
    const client = createGraphClient({ tokenProvider, fetchImpl });
    const msgs = await client.getAllMessagesSince('2030-01-01T00:00:05.000Z');
    expect(msgs.map((m) => m.chatId)).toEqual(['new']);
  });

  test('follows @odata.nextLink pagination', async () => {
    const base = 'https://graph.microsoft.com/v1.0';
    const fetchImpl = makeFetch({
      '/me?$select=id': { status: 200, body: { id: 'BOT' } },
      '$expand=lastMessagePreview': {
        status: 200,
        body: {
          '@odata.nextLink': `${base}/me/chats?page=2`,
          value: [chat('c1', msg('r1', 'U', 'A', '2030-01-01T00:00:01.000Z'))],
        },
      },
      'page=2': {
        status: 200,
        body: { value: [chat('c2', msg('r2', 'U', 'B', '2030-01-01T00:00:02.000Z'))] },
      },
    });
    const client = createGraphClient({ tokenProvider, fetchImpl });
    const msgs = await client.getAllMessagesSince(null);
    expect(msgs.map((m) => m.id)).toEqual(['r1', 'r2']);
  });
});

describe('graphClient.getChatMessages', () => {
  test('returns full history oldest-first, labelling bot / participant / system', async () => {
    const fetchImpl = makeFetch({
      '/me?$select=id': { status: 200, body: { id: 'BOT' } },
      '/messages': {
        status: 200,
        body: {
          value: [
            { id: 'sys', messageType: 'systemEventMessage', from: null, createdDateTime: '2030-01-01T00:00:00.000Z', body: { content: 'members added' } },
            { id: 'q1', messageType: 'message', from: { user: { id: 'BOT' } }, createdDateTime: '2030-01-01T00:00:02.000Z', body: { content: '<b>Question 1</b>' } },
            { id: 'a1', messageType: 'message', from: { user: { id: 'USER' } }, createdDateTime: '2030-01-01T00:00:03.000Z', body: { content: 'B' } },
          ],
        },
      },
    });
    const client = createGraphClient({ tokenProvider, fetchImpl });
    const msgs = await client.getChatMessages('chat1');
    expect(msgs.map((m) => [m.kind, m.text])).toEqual([
      ['system', 'members added'],
      ['bot', 'Question 1'],
      ['participant', 'B'],
    ]);
  });
});

describe('graphClient request retry', () => {
  test('retries on HTTP 429 honouring Retry-After, then succeeds', async () => {
    const fetchImpl = makeFetch({
      '/me?$select=id': [
        { status: 429, headers: { 'retry-after': '0' } }, // throttled once
        { status: 200, body: { id: 'BOT' } },
      ],
      '/me/chats': { status: 200, body: { value: [] } },
    });
    const client = createGraphClient({ tokenProvider, fetchImpl });
    const msgs = await client.getAllMessagesSince(null);
    expect(msgs).toEqual([]);
    expect(fetchImpl.calls['/me?$select=id']).toBe(2); // one 429 + one success
  });
});
