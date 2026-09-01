import { useEffect, useState } from 'react';
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

function Media({ rows }) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => {
    const src = mediaUrl(row);
    if (!src) {
      return null;
    }
    return <img className="forum-media" key={src || index} src={src} alt="" />;
  });
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

  async function maybeUpload({ topicId: id, postId, file, token }) {
    if (!file || !id) {
      return;
    }
    const imageBase64 = await fileToDataUrl(file);
    await uploadForumMedia({ topicId: id, postId, imageBase64 }, token);
  }

  async function startTopic(event) {
    event.preventDefault();
    if (!signedIn) {
      navigate(authFrom(window.location.pathname));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const created = await createForumTopic({
        categoryId: categoryId || categories[0]?.id || 'general',
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
      navigate(authFrom(window.location.pathname));
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

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Community</p>
          <h1>{topic ? topic.title : 'Forum'}</h1>
          <p className="muted">Public reads. Posts need a signed-in Firebase session. Images upload after the topic or reply id exists.</p>
        </div>
        <Link className="more" to="/forum" style={{ margin: 0 }}>All topics</Link>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {!data && !error ? <p className="muted">Loading forum…</p> : null}

      {!topicId ? (
        <>
          {categories.length ? (
            <nav className="comp-tabs" aria-label="Categories">
              <Link className={!categoryId ? 'on' : undefined} to="/forum">All</Link>
              {categories.map((row) => (
                <Link key={row.id} className={categoryId === row.id ? 'on' : undefined} to={`/forum/category/${row.id}`}>
                  {row.title || row.id}
                </Link>
              ))}
            </nav>
          ) : null}
          <form className="panel auth-card" onSubmit={startTopic}>
            <h2>Start a discussion</h2>
            <label className="sell-field">
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} minLength={6} required />
            </label>
            <label className="sell-field">
              Body
              <textarea value={body} onChange={(event) => setBody(event.target.value)} minLength={12} rows={4} required />
            </label>
            <label className="sell-field">
              Image
              <input type="file" accept="image/*" onChange={(event) => setTopicFile(event.target.files?.[0] || null)} />
            </label>
            <button
              className="btn"
              type={signedIn ? 'submit' : 'button'}
              disabled={busy}
              onClick={signedIn ? undefined : () => navigate(authFrom(window.location.pathname))}
            >
              {signedIn ? 'Post topic' : 'Sign in to post'}
            </button>
          </form>
          <div className="forum-list">
            {topics.map((row) => (
              <Link className="forum-row" key={row.id} to={`/forum/topic/${row.id}`}>
                <strong>{row.title}</strong>
                <span className="muted">{row.authorName || 'Collector'} · {row.replyCount || 0} replies</span>
              </Link>
            ))}
            {data && !topics.length ? <p className="muted">No topics in this category yet.</p> : null}
          </div>
        </>
      ) : (
        <>
          {topic ? <p className="lede-copy">{topic.body}</p> : null}
          {topic ? <Media rows={topic.media || topic.images} /> : null}
          <div className="forum-list">
            {posts.map((row) => (
              <article className="forum-row" key={row.id}>
                <strong>{row.authorName || 'Collector'}</strong>
                <p>{row.body}</p>
                <Media rows={row.media || row.images} />
              </article>
            ))}
          </div>
          <form className="panel auth-card" onSubmit={sendReply}>
            <label className="sell-field">
              Reply
              <textarea value={reply} onChange={(event) => setReply(event.target.value)} minLength={3} rows={3} required />
            </label>
            <label className="sell-field">
              Image
              <input type="file" accept="image/*" onChange={(event) => setReplyFile(event.target.files?.[0] || null)} />
            </label>
            <button
              className="btn"
              type={signedIn ? 'submit' : 'button'}
              disabled={busy}
              onClick={signedIn ? undefined : () => navigate(authFrom(window.location.pathname))}
            >
              {signedIn ? 'Reply' : 'Sign in to reply'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
