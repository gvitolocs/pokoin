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

// The header dot and the chat FAB markup are guarded in solid/src/components/Chrome.test.js.
test('the nav dot reads the same /api/chat list seam as the Messages page', () => {
  const chatClient = readFileSync(new URL('./chat-client.js', import.meta.url), 'utf8');
  assert.match(chatClient, /\/api\/chat\?action=list/);
});

test('refresh cadence and event name are stable constants', () => {
  assert.equal(MESSAGES_UNREAD_REFRESH_MS, 60000);
  assert.equal(MESSAGES_UNREAD_EVENT, 'pokoin:messages-unread');
});

test('the closed chat FAB is fixed bottom-right', () => {
  const css = readFileSync(new URL('./chat-dock.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-fab[\s\S]*position:\s*fixed/);
  assert.match(css, /\.chat-fab[\s\S]*bottom:/);
  assert.match(css, /\.chat-fab[\s\S]*right:/);
});
