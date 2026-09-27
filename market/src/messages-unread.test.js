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

test('closed ChatDock shows a fixed bottom-right FAB that opens the list', () => {
  const dock = readFileSync(new URL('./components/ChatDock.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./chat-dock.css', import.meta.url), 'utf8');
  assert.match(dock, /className="chat-fab"/);
  assert.match(dock, /openChatList\(\)/);
  assert.match(dock, /chat-fab-badge/);
  assert.match(css, /\.chat-fab[\s\S]*position:\s*fixed/);
  assert.match(css, /\.chat-fab[\s\S]*bottom:/);
  assert.match(css, /\.chat-fab[\s\S]*right:/);
});
