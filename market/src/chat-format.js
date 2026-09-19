export function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime() || 0;
  return 0;
}

export function chatTime(value, now = Date.now()) {
  const time = timestampMs(value);
  if (!time) return '';
  const date = new Date(time);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(date);
}

export function requestActionFor(event = {}) {
  if (event.type !== 'money_request' || event.requestStatus !== 'pending') return '';
  return event.mine ? 'cancel' : 'pay';
}

export function eventAriaLabel(event = {}) {
  const amount = `${Number(event.amountPkn || 0)} PKN`;
  if (event.type === 'payment') return event.mine ? `You sent ${amount}` : `You received ${amount}`;
  if (event.type === 'money_request') {
    const actor = event.mine ? 'You requested' : 'Requested from you';
    return `${actor} ${amount}, ${event.requestStatus || 'pending'}`;
  }
  return event.mine ? `You: ${event.text || ''}` : event.text || '';
}
