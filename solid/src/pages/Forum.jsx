import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { useParams } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  createForumPost,
  createForumTopic,
  fetchForum,
  fileToDataUrl,
  mediaUrl,
  uploadForumMedia,
} from '@market/api.js';
import { authFrom } from '@market/punchouts.js';
import '@market/forum.css';
import { Alert, FilePill, PageHead, SkeletonThreads } from '../components/Desk.jsx';
import { getBearer, signedIn } from '../stores/auth.js';

function initials(name) {
  const bits = String(name || 'C').trim().split(/\s+/).filter(Boolean);
  const letters = `${bits[0]?.[0] || 'C'}${bits[1]?.[0] || ''}`;
  return letters.toUpperCase();
}

function when(value) {
  if (!value) return '';
  const date = typeof value?.toDate === 'function'
    ? value.toDate()
    : typeof value?.seconds === 'number'
      ? new Date(value.seconds * 1000)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function excerptOf(row) {
  const text = String(row.excerpt || row.body || row.preview || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function repliesOf(row) {
  const n = Number(row.replyCount ?? row.replies ?? row.postCount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function categoryOf(row, categories) {
  const id = row.categoryId || row.category_id || row.category;
  return categories.find((cat) => cat.id === id) || null;
}

function Media(props) {
  const srcs = () => (Array.isArray(props.rows) ? props.rows : []).map((row) => mediaUrl(row)).filter(Boolean);
  return <For each={srcs()}>{(src) => <img class="forum-media" src={src} alt="" />}</For>;
}

const CAT_ICONS = {
  forum: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
  cards: 'M4 6h12v12H4V6zm14 2h2v12H8v-2h10V8z',
  token: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-2-5h1.5V9H10V7.5h4V9h-1.5v6H14V16.5h-4V15z',
  validators: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
};

function CatIcon(props) {
  return (
    <span class="forum-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16">
        <path fill="currentColor" d={CAT_ICONS[props.name] || CAT_ICONS.forum} />
      </svg>
    </span>
  );
}

function Avatar(props) {
  return <span class="forum-avatar" aria-hidden="true">{initials(props.name)}</span>;
}

function streamOf(topic, posts) {
  const rows = Array.isArray(posts) ? [...posts] : [];
  if (!topic?.body) return rows;
  const first = rows[0];
  const same = first && (first.body === topic.body || first.id === topic.firstPostId);
  if (same) return rows;
  return [{
    id: `op-${topic.id}`,
    authorName: topic.authorName || topic.author || 'Collector',
    body: topic.body,
    createdAt: topic.createdAt || topic.created_at,
    media: topic.media || topic.images,
    op: true,
  }, ...rows];
}

/** /forum, /forum/category/:categoryId, /forum/topic/:topicId. */
export default function Forum() {
  const params = useParams();
  const navigate = useGameNavigate();
  const [data, setData] = createSignal(null);
  const [error, setError] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [body, setBody] = createSignal('');
  const [reply, setReply] = createSignal('');
  const [topicFile, setTopicFile] = createSignal(null);
  const [replyFile, setReplyFile] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [composeOpen, setComposeOpen] = createSignal(false);
  const [composeCategory, setComposeCategory] = createSignal('');

  const categoryId = () => params.categoryId;
  const topicId = () => params.topicId;

  createEffect(
    () => ({ categoryId: categoryId(), topicId: topicId() }),
    (query) => {
      document.title = 'Forum · Pokoin';
      let cancelled = false;
      setData(null);
      fetchForum(query)
        .then((payload) => {
          if (cancelled) return;
          setData(() => payload);
          setError('');
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Forum failed.');
        });
      return () => {
        cancelled = true;
      };
    },
  );

  const categories = () => data()?.categories || [];
  const topics = () => data()?.topics || [];
  const topic = () => data()?.topic || null;
  const stream = createMemo(() => streamOf(topic(), data()?.posts || []));
  const activeCategory = () => categories().find((row) => row.id === categoryId()) || null;
  const topicCategory = () => (topic() ? categoryOf(topic(), categories()) : null);

  createEffect(
    () => categoryId() || data()?.categories?.[0]?.id || 'general',
    (next) => { setComposeCategory(next); },
  );
  createEffect(
    () => topic()?.title,
    (topicTitle) => {
      if (topicTitle) document.title = `${topicTitle} · Forum · Pokoin`;
    },
  );

  function needAuth() {
    navigate(authFrom(window.location.pathname + window.location.search));
  }

  function openComposer() {
    if (!signedIn()) {
      needAuth();
      return;
    }
    setComposeOpen(true);
  }

  async function maybeUpload({ topicId: id, postId, file, token }) {
    if (!file || !id) return;
    const imageBase64 = await fileToDataUrl(file);
    await uploadForumMedia({ topicId: id, postId, imageBase64 }, token);
  }

  async function startTopic(event) {
    event.preventDefault();
    if (!signedIn()) {
      needAuth();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const created = await createForumTopic({
        categoryId: composeCategory() || categoryId() || categories()[0]?.id || 'general',
        title: title().trim(),
        body: body().trim(),
      }, token);
      const id = created?.topic?.id || created?.id;
      try {
        await maybeUpload({ topicId: id, file: topicFile(), token });
      } catch (uploadErr) {
        setError(uploadErr.message || 'Topic posted; image upload failed.');
      }
      setTitle('');
      setBody('');
      setTopicFile(null);
      setComposeOpen(false);
      if (id) navigate(`/forum/topic/${id}`);
    } catch (err) {
      setError(err.message || 'Could not create topic.');
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(event) {
    event.preventDefault();
    if (!signedIn()) {
      needAuth();
      return;
    }
    setBusy(true);
    setError('');
    const id = topicId();
    try {
      const token = await getBearer();
      const created = await createForumPost({ topicId: id, body: reply().trim() }, token);
      const postId = created?.post?.id || created?.id;
      try {
        await maybeUpload({ topicId: id, postId, file: replyFile(), token });
      } catch (uploadErr) {
        setError(uploadErr.message || 'Reply posted; image upload failed.');
      }
      setReply('');
      setReplyFile(null);
      const payload = await fetchForum({ topicId: id });
      setData(() => payload);
    } catch (err) {
      setError(err.message || 'Reply failed.');
    } finally {
      setBusy(false);
    }
  }

  const composer = () => (
    <form class="forum-composer" onSubmit={startTopic}>
      <Show when={!categoryId()}>
        <label class="sell-field">
          Category
          <select value={composeCategory()} onChange={(event) => setComposeCategory(event.currentTarget.value)}>
            <For each={categories()}>{(row) => <option value={row.id}>{row.title || row.id}</option>}</For>
          </select>
        </label>
      </Show>
      <label class="sell-field">
        Title
        <input value={title()} onInput={(event) => setTitle(event.currentTarget.value)} minlength={6} required placeholder="What’s this about?" />
      </label>
      <label class="sell-field">
        Post
        <textarea value={body()} onInput={(event) => setBody(event.currentTarget.value)} minlength={12} rows={6} required placeholder="Write the first post…" />
      </label>
      <div class="forum-composer-actions">
        <FilePill accept="image/*" onChange={(event) => setTopicFile(() => event.currentTarget.files?.[0] || null)}>
          {topicFile() ? topicFile().name : 'Attach image'}
        </FilePill>
        <button class="btn" type="submit" disabled={busy()}>{busy() ? 'Posting…' : 'Post discussion'}</button>
        <button class="btn ghost" type="button" onClick={() => setComposeOpen(false)}>Cancel</button>
      </div>
    </form>
  );

  return (
    <div class="page desk forum-page">
      <Show when={topicId() && topic()}>
        <nav class="forum-crumbs">
          <a href="/forum">Forum</a>
          <span>/</span>
          <Show when={topicCategory()}>
            {(cat) => (
              <>
                <a href={`/forum/category/${cat().id}`}>{cat().title}</a>
                <span>/</span>
              </>
            )}
          </Show>
          <span>{topic().title}</span>
        </nav>
      </Show>

      <PageHead
        kicker="Community"
        title={topic() ? topic().title : (activeCategory()?.title || 'Forum')}
        lede={topic()
          ? [topic().authorName || 'Collector', when(topic().createdAt || topic().created_at)].filter(Boolean).join(' · ')
          : (activeCategory()?.description || 'Discuss cards, PKN, and the network. Public to read.')}
      >
        <Show
          when={topicId()}
          fallback={<button class="btn" type="button" onClick={openComposer}>New discussion</button>}
        >
          <a class="btn ghost" href={categoryId() ? `/forum/category/${categoryId()}` : '/forum'}>All discussions</a>
        </Show>
      </PageHead>
      <Alert>{error()}</Alert>
      <Show when={!data() && !error()}><SkeletonThreads rows={6} /></Show>

      <Show when={data() && !topicId()}>
        <div class="forum-cats">
          <For each={categories()}>
            {(row) => (
              <a
                class={['forum-cat', { on: categoryId() === row.id }]}
                href={categoryId() === row.id ? '/forum' : `/forum/category/${row.id}`}
              >
                <div class="forum-cat-top">
                  <CatIcon name={row.icon_name || row.icon} />
                  <strong>{row.title || row.id}</strong>
                </div>
                <Show when={row.description}><p>{row.description}</p></Show>
                <div class="forum-cat-meta">
                  <span><b>{row.topic_count ?? row.topicCount ?? 0}</b> topics</span>
                  <span><b>{row.post_count ?? row.postCount ?? 0}</b> posts</span>
                </div>
              </a>
            )}
          </For>
        </div>

        <div class="forum-toolbar">
          <p class="result-count">
            <Show
              when={topics().length}
              fallback={activeCategory() ? `No discussions in ${activeCategory().title}` : 'No discussions yet'}
            >
              <strong>{topics().length}</strong> {topics().length === 1 ? 'discussion' : 'discussions'}{activeCategory() ? ` in ${activeCategory().title}` : ''}
            </Show>
          </p>
          <Show when={categoryId()}><a class="btn ghost" href="/forum">All categories</a></Show>
        </div>

        <Show
          when={topics().length}
          fallback={(
            <div class="forum-topics">
              <div class="forum-empty">
                <Avatar name="Pokoin" />
                <strong>Be the first</strong>
                <p>This board is public to read. Start a discussion after you sign in — we do not seed fake threads.</p>
                <button class="btn" type="button" onClick={openComposer}>New discussion</button>
              </div>
            </div>
          )}
        >
          <div class="forum-topics">
            <For each={topics()}>
              {(row) => {
                const cat = () => categoryOf(row, categories());
                const n = repliesOf(row);
                const author = row.authorName || row.author || 'Collector';
                const updated = when(row.updatedAt || row.lastPostedAt || row.createdAt);
                return (
                  <a class="forum-topic" href={`/forum/topic/${row.id}`}>
                    <Avatar name={author} />
                    <span>
                      <strong class="forum-topic-title">{row.title}</strong>
                      <Show when={excerptOf(row)}><span class="forum-topic-excerpt">{excerptOf(row)}</span></Show>
                      <span class="forum-topic-meta">
                        <Show when={cat()}><span class="forum-chip">{cat().title}</span></Show>
                        <span>{author}</span>
                        <Show when={updated}><span>{updated}</span></Show>
                      </span>
                    </span>
                    <span class="forum-replies">
                      {n}
                      <small>{n === 1 ? 'reply' : 'replies'}</small>
                    </span>
                  </a>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={composeOpen()}>{composer()}</Show>
      </Show>

      <Show when={data() && topicId()}>
        <div class="forum-post-stream">
          <Show
            when={stream().length}
            fallback={(
              <div class="forum-empty">
                <strong>No posts in this thread</strong>
                <p>Reply below if you are signed in.</p>
              </div>
            )}
          >
            <For each={stream()}>
              {(row) => (
                <article class="forum-post">
                  <Avatar name={row.authorName || row.author || 'Collector'} />
                  <div>
                    <div class="forum-post-head">
                      <strong>{row.authorName || row.author || 'Collector'}</strong>
                      <Show when={row.op}><span class="forum-chip on">Original</span></Show>
                      <Show when={when(row.createdAt || row.created_at)}>
                        <time>{when(row.createdAt || row.created_at)}</time>
                      </Show>
                    </div>
                    <p class="forum-post-body">{row.body}</p>
                    <Media rows={row.media || row.images} />
                  </div>
                </article>
              )}
            </For>
          </Show>
        </div>
        <form class="forum-composer" onSubmit={sendReply}>
          <label class="sell-field">
            Reply
            <textarea value={reply()} onInput={(event) => setReply(event.currentTarget.value)} minlength={3} rows={5} required placeholder={signedIn() ? 'Write a reply…' : 'Sign in to reply'} />
          </label>
          <div class="forum-composer-actions">
            <FilePill accept="image/*" onChange={(event) => setReplyFile(() => event.currentTarget.files?.[0] || null)}>
              {replyFile() ? replyFile().name : 'Attach image'}
            </FilePill>
            <Show
              when={signedIn()}
              fallback={<button class="btn" type="button" onClick={needAuth}>Sign in to reply</button>}
            >
              <button class="btn" type="submit" disabled={busy()}>{busy() ? 'Sending…' : 'Reply'}</button>
            </Show>
          </div>
        </form>
      </Show>
    </div>
  );
}
