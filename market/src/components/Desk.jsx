import { Link } from 'react-router-dom';

export function PageHead({ kicker, title, lede, children }) {
  return (
    <header className="page-head">
      <div>
        {kicker ? <p className="page-kicker">{kicker}</p> : null}
        <h1 className="page-title">{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function Metric({ value, label, hint }) {
  return (
    <div className="metric">
      <strong className="metric-value">{value}</strong>
      <span className="metric-label">{label}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

export function MetricGrid({ children }) {
  return <div className="metric-grid">{children}</div>;
}

export function DeskPanel({ title, extra, children, actions, flush }) {
  return (
    <section className={`desk-panel${flush ? ' flush' : ''}`}>
      {title || extra ? (
        <div className="desk-panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {extra}
        </div>
      ) : null}
      <div className="desk-body">{children}</div>
      {actions ? <div className="desk-actions">{actions}</div> : null}
    </section>
  );
}

export function EmptyDesk({ title, lede, nested, children }) {
  return (
    <div className={nested ? 'empty-desk nested' : 'empty-desk'}>
      <div className="empty-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path fill="currentColor" d="M7 3h10a2 2 0 0 1 2 2v14l-7-3-7 3V5a2 2 0 0 1 2-2zm0 2v11.2l5-2.1 5 2.1V5H7z" />
        </svg>
      </div>
      <p className="empty-title">{title}</p>
      {lede ? <p className="empty-lede">{lede}</p> : null}
      {children ? <div className="empty-cta">{children}</div> : null}
    </div>
  );
}

export function Alert({ children }) {
  if (!children) return null;
  return <p className="desk-alert" role="status">{children}</p>;
}

export function SessionWait() {
  return (
    <div className="page desk">
      <SkeletonThreads rows={3} />
    </div>
  );
}

export function SkeletonThreads({ rows = 4 }) {
  return (
    <div className="skeleton-thread" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

export function Thread({ to, title, meta, children }) {
  const inner = (
    <>
      <span className="thread-main">
        <strong className="thread-title">{title}</strong>
        {meta ? <span className="thread-meta">{meta}</span> : null}
        {children}
      </span>
      <svg className="thread-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M9.3 6.3 8 7.6 12.6 12 8 16.4l1.3 1.3 6-5.7z" />
      </svg>
    </>
  );
  if (to) {
    return <Link className="thread" to={to}>{inner}</Link>;
  }
  return <article className="thread">{inner}</article>;
}

export function FilePill({ children, ...props }) {
  return (
    <label className="file-pill">
      <input type="file" {...props} />
      <span>{children}</span>
    </label>
  );
}
