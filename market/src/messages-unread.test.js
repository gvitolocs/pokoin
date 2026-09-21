import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MESSAGES_UNREAD_EVENT, MESSAGES_UNREAD_REFRESH_MS, unreadMessagesCount } from './messages-unread.js';

test('unreadMessagesCount sums per-conversation unread counts', () => {
  assert.equal(unreadMessagesCount([]), 0);
  assert.equal(unreadMessagesCount([{ unread: 0 }, { unread: 3 }]), 3);
  assert.equal(unreadMessagesCount([{ unread: 2 }, { unread: 1 }]), 3);
  assert.equal(unreadMessagesCount([null, undefined, { peerUsername: 'a' }, { unread: '4' }]), 4);
});

test('the nav dot is driven by the same /api/chat list seam as the Messages page', () => {
  const chrome = readFileSync(new URL('./components/Chrome.jsx', import.meta.url), 'utf8');
  assert.match(chrome, /listConversations/);
  assert.match(chrome, /unreadMessagesCount/);
  assert.match(chrome, /messages-unread-dot/);
  assert.match(chrome, /MESSAGES_UNREAD_REFRESH_MS/);

  const chatClient = readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');
  assert.match(chatClient, /\/api\/chat\?action=list/);
});

test('refresh cadence and event name are stable constants', () => {
  assert.equal(MESSAGES_UNREAD_REFRESH_MS, 60000);
  assert.equal(MESSAGES_UNREAD_EVENT, 'pokoin:messages-unread');
});
