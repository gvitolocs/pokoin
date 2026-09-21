// Shared seam for "does the current user have unread direct messages?".
// Single source of truth: GET /api/chat?action=list (server/pokoin-api/chat.js),
// which already returns per-conversation `unread` counts for the signed-in user.

export const MESSAGES_UNREAD_REFRESH_MS = 60000;
export const MESSAGES_UNREAD_EVENT = 'pokoin:messages-unread';

/** Sum per-conversation unread counts; the API only counts rows the user has not read. */
export function unreadMessagesCount(conversations = []) {
  return conversations.reduce((sum, row) => sum + (Number(row?.unread) > 0 ? Number(row.unread) : 0), 0);
}
