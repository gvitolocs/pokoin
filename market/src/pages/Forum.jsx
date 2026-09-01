import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createForumPost,
  createForumTopic,
  fetchForum,
  fileToDataUrl,
  mediaUrl,
  uploadForumMedia,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, FilePill, PageHead, SkeletonThreads } from '../components/Desk.jsx';
import '../forum.css';

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

function Media({ rows }) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => {
    const src = mediaUrl(row);
    if (!src) return null;
    return <img className="forum-media" key={src || index} src={src} alt="" />;
  });
}

function CatIcon({ name }) {
  const d = {
    forum: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
    cards: 'M4 6h12v12H4V6zm14 2h2v12H8v-2h10V8z',
    token: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-2-5h1.5V9H10V7.5h4V9h-1.5v6H14V16.5h-4V15z',
    validators: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
  }[name] || 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z';
  return (
    <span className="forum-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d={d} /></svg>
    </span>
  );
}

function Avatar({ name }) {
  return <span className="forum-avatar" aria-hidden="true">{initials(name)}</span>;
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

export default function Forum() {
  const { categoryId, topicId } = useParams();
  const navigate = useNavigate();
  const { signedIn, getBearer } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [topicFile, setTopicFile] = useState(null);
  const [replyFile, setReplyFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeCategory, setComposeCategory] = useState('');

  useEffect(() => {
    document.title = 'Forum · Pokoin';
    let cancelled = false;
    setData(null);
    fetchForum({ categoryId, topicId })
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Forum failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [categoryId, topicId]);

  const categories = data?.categories || [];
  const topics = data?.topics || [];
  const topic = data?.topic || null;
  const posts = data?.posts || [];
  const stream = useMemo(() => streamOf(topic, posts), [topic, posts]);
  const activeCategory = categories.find((row) => row.id === categoryId) || null;

  useEffect(() => {
    setComposeCategory(categoryId || data?.categories?.[0]?.id || 'general');
  }, [categoryId, data]);

  useEffect(() => {
    if (topic?.title) document.title = `${topic.title} · Forum · Pokoin`;
  }, [topic]);

  function needAuth() {
    navigate(authFrom(window.location.pathname + window.location.search));
  }

  function openComposer() {
    if (!signedIn) {
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
    if (!signedIn) {
      needAuth();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const created = await createForumTopic({
        categoryId: composeCategory || categoryId || categories[0]?.id || 'general',
        title: title.trim(),
        body: body.trim(),
      }, token);
      const id = created?.topic?.id || created?.id;
      try {
        await maybeUpload({ topicId: id, file: topicFile, token });
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
    if (!signedIn) {
      needAuth();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const created = await createForumPost({ topicId, body: reply.trim() }, token);
      const postId = created?.post?.id || created?.id;
      try {
        await maybeUpload({ topicId, postId, file: replyFile, token });
      } catch (uploadErr) {
        setError(uploadErr.message || 'Reply posted; image upload failed.');
      }
      setReply('');
      setReplyFile(null);
      const payload = await fetchForum({ topicId });
      setData(payload);
    } catch (err) {
      setError(err.message || 'Reply failed.');
    } finally {
      setBusy(false);
    }
  }

  const composer = (
    <form className="forum-composer" onSubmit={startTopic}>
      {!categoryId ? (
        <label className="sell-field">
          Category
          <select value={composeCategory} onChange={(event) => setComposeCategory(event.target.value)}>
            {categories.map((row) => (
              <option key={row.id} value={row.id}>{row.title || row.id}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="sell-field">
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={6} required placeholder="What’s this about?" />
      </label>
      <label className="sell-field">
        Post
        <textarea value={body} onChange={(event) => setBody(event.target.value)} minLength={12} rows={6} required placeholder="Write the first post…" />
      </label>
      <div className="forum-composer-actions">
        <FilePill accept="image/*" onChange={(event) => setTopicFile(event.target.files?.[0] || null)}>
          {topicFile ? topicFile.name : 'Attach image'}
        </FilePill>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post discussion'}</button>
        <button className="btn ghost" type="button" onClick={() => setComposeOpen(false)}>Cancel</button>
      </div>
    </form>
  );

  return (
    <div className="page desk forum-page">
      {topicId && topic ? (
        <nav className="forum-crumbs">
          <Link to="/forum">Forum</Link>
          <span>/</span>
          {categoryOf(topic, categories) ? (
            <>
              <Link to={`/forum/category/${categoryOf(topic, categories).id}`}>{categoryOf(topic, categories).title}</Link>
              <span>/</span>
            </>
          ) : null}
          <span>{topic.title}</span>
        </nav>
      ) : null}

      <PageHead
        kicker="Community"
        title={topic ? topic.title : (activeCategory?.title || 'Forum')}
        lede={topic
          ? [topic.authorName || 'Collector', when(topic.createdAt || topic.created_at)].filter(Boolean).join(' · ')
          : (activeCategory?.description || 'Discuss cards, PKN, and the network. Public to read.')}
      >
        {topicId ? (
          <Link className="btn ghost" to={categoryId ? `/forum/category/${categoryId}` : '/forum'}>All discussions</Link>
        ) : (
          <button className="btn" type="button" onClick={openComposer}>New discussion</button>
        )}
      </PageHead>
      <Alert>{error}</Alert>
      {!data && !error ? <SkeletonThreads rows={6} /> : null}

      {data && !topicId ? (
        <>
          <div className="forum-cats">
            {categories.map((row) => (
              <Link
                key={row.id}
                className={categoryId === row.id ? 'forum-cat on' : 'forum-cat'}
                to={categoryId === row.id ? '/forum' : `/forum/category/${row.id}`}
              >
                <div className="forum-cat-top">
                  <CatIcon name={row.icon_name || row.icon} />
                  <strong>{row.title || row.id}</strong>
                </div>
                {row.description ? <p>{row.description}</p> : null}
                <div className="forum-cat-meta">
                  <span><b>{row.topic_count ?? row.topicCount ?? 0}</b> topics</span>
                  <span><b>{row.post_count ?? row.postCount ?? 0}</b> posts</span>
                </div>
              </Link>
            ))}
          </div>

          <div className="forum-toolbar">
            <p className="result-count">
              {topics.length
                ? <><strong>{topics.length}</strong> {topics.length === 1 ? 'discussion' : 'discussions'}{activeCategory ? ` in ${activeCategory.title}` : ''}</>
                : (activeCategory ? `No discussions in ${activeCategory.title}` : 'No discussions yet')}
            </p>
            {categoryId ? <Link className="btn ghost" to="/forum">All categories</Link> : null}
          </div>

          {topics.length ? (
            <div className="forum-topics">
              {topics.map((row) => {
                const cat = categoryOf(row, categories);
                const n = repliesOf(row);
                const author = row.authorName || row.author || 'Collector';
                return (
                  <Link className="forum-topic" key={row.id} to={`/forum/topic/${row.id}`}>
                    <Avatar name={author} />
                    <span>
                      <strong className="forum-topic-title">{row.title}</strong>
                      {excerptOf(row) ? <span className="forum-topic-excerpt">{excerptOf(row)}</span> : null}
                      <span className="forum-topic-meta">
                        {cat ? <span className="forum-chip">{cat.title}</span> : null}
                        <span>{author}</span>
                        {when(row.updatedAt || row.lastPostedAt || row.createdAt) ? (
                          <span>{when(row.updatedAt || row.lastPostedAt || row.createdAt)}</span>
                        ) : null}
                      </span>
                    </span>
                    <span className="forum-replies">
                      {n}
                      <small>{n === 1 ? 'reply' : 'replies'}</small>
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="forum-topics">
              <div className="forum-empty">
                <Avatar name="Pokoin" />
                <strong>Be the first</strong>
                <p>This board is public to read. Start a discussion after you sign in — we do not seed fake threads.</p>
                <button className="btn" type="button" onClick={openComposer}>New discussion</button>
              </div>
            </div>
          )}

          {composeOpen ? composer : null}
        </>
      ) : null}

      {data && topicId ? (
        <>
          <div className="forum-post-stream">
            {stream.length ? stream.map((row) => (
              <article className="forum-post" key={row.id}>
                <Avatar name={row.authorName || row.author || 'Collector'} />
                <div>
                  <div className="forum-post-head">
                    <strong>{row.authorName || row.author || 'Collector'}</strong>
                    {row.op ? <span className="forum-chip on">Original</span> : null}
                    {when(row.createdAt || row.created_at) ? <time>{when(row.createdAt || row.created_at)}</time> : null}
                  </div>
                  <p className="forum-post-body">{row.body}</p>
                  <Media rows={row.media || row.images} />
                </div>
              </article>
            )) : (
              <div className="forum-empty">
                <strong>No posts in this thread</strong>
                <p>Reply below if you are signed in.</p>
              </div>
            )}
          </div>
          <form className="forum-composer" onSubmit={sendReply}>
            <label className="sell-field">
              Reply
              <textarea value={reply} onChange={(event) => setReply(event.target.value)} minLength={3} rows={5} required placeholder={signedIn ? 'Write a reply…' : 'Sign in to reply'} />
            </label>
            <div className="forum-composer-actions">
              <FilePill accept="image/*" onChange={(event) => setReplyFile(event.target.files?.[0] || null)}>
                {replyFile ? replyFile.name : 'Attach image'}
              </FilePill>
              {signedIn ? (
                <button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Reply'}</button>
              ) : (
                <button className="btn" type="button" onClick={needAuth}>Sign in to reply</button>
              )}
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
