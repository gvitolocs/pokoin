import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { POKOIN_CHAIN_ID, POKOIN_RPC } from '../wallet.jsx';

const PAGES = {
  '/docs': {
    eyebrow: 'Network',
    title: 'Host a node',
    lead: 'PokoinPoS is permissioned proof-of-stake. Public RPC and explorer stay off this SPA.',
    body: [
      ['Overview', 'Peers vote, marketplace API sits in front of Postgres, PKN is the native gas.'],
      ['Run a node', 'Docker peer images live in the chain repo. Do not point api.pokoin.com at a new region until restore is verified.'],
      ['Wallets', `Injected wallets use chain ID ${POKOIN_CHAIN_ID} and ${POKOIN_RPC}.`],
      ['Health', 'Use /health here or the live RPC. Explorer is Caddy, not Vercel.'],
    ],
  },
  '/about': {
    eyebrow: 'Pokoin',
    title: 'About',
    lead: 'A peer-to-peer Pokémon card marketplace. Buy. Sell. Settle in PKN.',
    body: [
      ['Public web', 'This React SPA on pokoin.com. Android/iOS CardVault is a separate app on app.pokoin.com.'],
      ['Identity', 'Public card_id is CardTrader blueprint × 2. Never divide it in the URL.'],
    ],
  },
  '/contact': {
    eyebrow: 'Support',
    title: 'Contact',
    lead: 'Email contact@pokoin.com. Forum is public for collectors.',
    body: [['Forum', 'Open /forum to read. Posting needs a signed-in account.']],
  },
  '/privacy': {
    eyebrow: 'Legal',
    title: 'Privacy',
    lead: 'Auth is Firebase. Cart and watchlist start on this browser. Listings go through api.pokoin.com with a bearer token.',
    body: [['Contact', 'privacy questions: contact@pokoin.com']],
  },
  '/earn': {
    eyebrow: 'PKN',
    title: 'Earn PKN',
    lead: 'List cards for PKN. Host a peer if you are vetted. Do not invent yield numbers.',
    body: [['Sell', 'Inventory and the card desk List form are the honest path.']],
  },
  '/whitepaper': {
    eyebrow: 'Docs',
    title: 'Whitepaper',
    lead: 'Chain ID 26062026. Permissioned PoS. Security PDF is Go-native tooling, not a paid third-party audit.',
    body: [['Audit', 'See /audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf on the landing host.']],
  },
  '/health': {
    eyebrow: 'Network',
    title: 'Health',
    lead: 'RPC probe from this browser. Explorer stays on explorer.pokoin.com.',
    body: [],
  },
};

export default function Site() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/$/, '') || '/about';
  const page = PAGES[path] || PAGES['/about'];
  const [rpc, setRpc] = useState(path === '/health' ? 'Checking RPC…' : '');

  useEffect(() => {
    document.title = `${page.title} · Pokoin`;
    if (path !== '/health') return undefined;
    let cancelled = false;
    fetch(POKOIN_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const id = Number.parseInt(data.result, 16);
        setRpc(Number.isFinite(id) ? `RPC ok · chain ${id}` : 'RPC answered without a chain id.');
      })
      .catch(() => {
        if (!cancelled) setRpc('RPC unreachable from this browser.');
      });
    return () => {
      cancelled = true;
    };
  }, [page.title, path]);

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">{page.eyebrow}</p>
          <h1>{page.title}</h1>
          <p className="muted">{page.lead}</p>
        </div>
      </div>
      {rpc ? <p className="lede-copy">{rpc}</p> : null}
      {page.body.map(([heading, copy]) => (
        <section key={heading} className="panel site-block">
          <h2>{heading}</h2>
          <p>{copy}</p>
        </section>
      ))}
      <p className="muted">
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
