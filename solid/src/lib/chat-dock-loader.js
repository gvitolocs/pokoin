import { lazyModule } from './lazy-module.js';

/**
 * The chat dock (FAB, conversation list, threads, Poko) is its own chunk with
 * its own CSS. The shell loads it when the page goes idle after the first
 * paint, or right away when something opens a conversation first (the
 * Messages hover preview). market/src/chat-dock-store.js holds the open /
 * peer state, so a thread opened before the chunk lands is shown on arrival.
 */
export const chatDock = lazyModule(() => import('../components/ChatDock.jsx'));
