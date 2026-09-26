export default function ChatPhotos({ urls = [] }) {
  if (!urls.length) return null;
  return (
    <span className="chat-photos">
      {urls.map((url) => (
        <a key={url} href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="" />
        </a>
      ))}
    </span>
  );
}
