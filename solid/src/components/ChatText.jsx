import { For, Show } from 'solid-js';

const URL_SPLIT_RE = /(https?:\/\/[^\s<>\]\)]+)/g;
const URL_TEST_RE = /^https?:\/\/[^\s<>\]\)]+$/i;

/** Plain chat prose with clickable bare URLs (market/src/components/ChatText.jsx). */
export default function ChatText(props) {
  const raw = () => String(props.text || '');
  return (
    <Show when={raw()}>
      <p class={props.class || undefined}>
        <For each={raw().split(URL_SPLIT_RE)}>
          {(part) => (URL_TEST_RE.test(part)
            ? (
              <a href={part} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
                {part.replace(/^https?:\/\//i, '')}
              </a>
            )
            : <span>{part}</span>)}
        </For>
      </p>
    </Show>
  );
}
