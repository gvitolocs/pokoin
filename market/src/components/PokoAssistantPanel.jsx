import { useEffect, useRef, useState } from 'react';
import { askPoko } from '../api.js';
import { useAuth } from '../auth.jsx';
import '../chat-dock.css';

const WELCOME = {
  id: 'poko-welcome',
  mine: false,
  text: 'Hi! I\'m Poko ✨ your Pokoin assistant. Ask me about cards, prices, or the marketplace — this chat is private to you. 😊',
};

let pokoSessionCounter = 0;

export default function PokoAssistantPanel() {
  const { getBearer } = useAuth();
  const [sessionId] = useState(() => {
    pokoSessionCounter += 1;
    return `site-dock-${Date.now().toString(36)}-${pokoSessionCounter}`;
  });
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  async function send(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, mine: true, text }]);
    setBusy(true);
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Please sign in to chat with Poko.');
      const data = await askPoko(bearer, text, sessionId);
      setMessages((prev) => [...prev, {
        id: `p-${Date.now()}`,
        mine: false,
        text: data?.reply || 'I drew a blank there — try rephrasing? 😊',
      }]);
    } catch (error) {
      setMessages((prev) => [...prev, {
        id: `e-${Date.now()}`,
        mine: false,
        text: error?.message || 'Poko is resting for a moment 🛠️ — try again soon.',
      }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="poko-panel">
      <div className="chat-dock-log poko-log" ref={logRef}>
        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble${message.mine ? ' mine' : ''}`}>
            <p>{message.text}</p>
          </div>
        ))}
        {busy ? <p className="chat-dock-hint">Poko is typing…</p> : null}
      </div>
      <form className="poko-input-row" onSubmit={send}>
        <label className="sr-only" htmlFor="poko-input">Message Poko</label>
        <input
          id="poko-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask Poko about cards, prices, Pokoin…"
          maxLength={1000}
          autoComplete="off"
        />
        <button type="submit" className="btn" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
