import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { probeRpc, sitePage } from '../site-pages.js';
import { DeskPanel, PageHead } from '../components/Desk.jsx';

export default function Site() {
  const { pathname } = useLocation();
  const { path, page } = sitePage(pathname);
  const [rpc, setRpc] = useState(path === '/health' ? 'Checking RPC…' : '');

  useEffect(() => {
    document.title = `${page.title} · Pokoin`;
    if (path !== '/health') return undefined;
    let cancelled = false;
    probeRpc().then((status) => {
      if (!cancelled) setRpc(status);
    });
    return () => {
      cancelled = true;
    };
  }, [page.title, path]);

  return (
    <div className="page desk">
      <PageHead kicker={page.eyebrow} title={page.title} lede={page.lead} />
      {rpc ? <p className="desk-ok">{rpc}</p> : null}
      {page.body.map(([heading, copy]) => (
        <DeskPanel key={heading} title={heading}>
          <p className="page-lede">{copy}</p>
        </DeskPanel>
      ))}
      <p className="page-lede">
        <Link to="/marketplace">Marketplace</Link>
        {' · '}
        <Link to="/docs">Docs</Link>
        {' · '}
        <Link to="/wallet">Wallet</Link>
        {' · '}
        <a href="https://explorer.pokoin.com">Explorer</a>
      </p>
    </div>
  );
}
