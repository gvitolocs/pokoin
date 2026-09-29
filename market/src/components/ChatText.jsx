const URL_SPLIT_RE = /(https?:\/\/[^\s<>\]\)]+)/g;
const URL_TEST_RE = /^https?:\/\/[^\s<>\]\)]+$/i;

/** Plain chat prose with clickable bare URLs (Hermes strips markdown links). */
export default function ChatText({ text = '', className = '' }) {
  const raw = String(text || '');
  if (!raw) return null;
  const parts = raw.split(URL_SPLIT_RE);
  return (
    <p className={className || undefined}>
      {parts.map((part, index) => (
        URL_TEST_RE.test(part)
          ? (
            <a
              key={`u-${index}`}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
            >
              {part.replace(/^https?:\/\//i, '')}
            </a>
          )
          : <span key={`t-${index}`}>{part}</span>
      ))}
    </p>
  );
}
