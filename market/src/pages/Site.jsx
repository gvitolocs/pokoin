import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { POKOIN_CHAIN_ID, POKOIN_RPC } from '../wallet.jsx';
import { DeskPanel, PageHead } from '../components/Desk.jsx';

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
    eyebrow: 'Effective May 20, 2026',
    title: 'Privacy Policy',
    lead: 'This policy explains how Pokoin handles information across pokoin.com, Card Reserve marketplace features, Pokoin accounts, wallet tools, PokoinScan, PKN, wPKN, and related ecosystem services.',
    body: [
      ['Information we collect', 'Pokoin may collect account details such as your email address, display name, username, wallet address, profile image, marketplace activity, forum posts, support messages, and settings you choose to save. When you buy, sell, top up, withdraw, or connect a wallet, we process the information needed to complete that action.'],
      ['Payments and wallet activity', 'Payment processing is handled by third-party payment providers such as Stripe. Pokoin does not store full card numbers. Public blockchain transactions, wallet addresses, balances, validator activity, and reserve information may be visible on-chain or through PokoinScan because blockchains are public by design.'],
      ['How we use information', 'We use information to provide accounts, wallet linking, marketplace listings, checkout, PKN balance features, withdrawals, fraud prevention, customer support, network status, security monitoring, and product improvements. We may also use contact information to send account, verification, transaction, or security messages.'],
      ['Service providers', 'Pokoin relies on service providers for hosting, authentication, storage, email delivery, payments, analytics, marketplace operations, and blockchain infrastructure. These providers may process information only as needed to deliver their services to Pokoin and its users.'],
      ['Cookies and local storage', 'The site may use cookies, browser storage, wallet provider state, Firebase session data, and similar technologies to keep you signed in, secure your account, remember preferences, and operate the app. You can control some storage through your browser settings, but disabling it may break account or wallet features.'],
      ['Sharing and disclosures', 'We do not sell personal information. We may disclose information when required by law, to protect users and the network, to prevent fraud or abuse, to complete marketplace transactions, or as part of a business transfer involving the Pokoin ecosystem.'],
      ['Retention and security', 'We keep information for as long as needed to provide the service, meet legal and accounting requirements, resolve disputes, prevent abuse, and maintain network integrity. We use technical and organizational safeguards, but no online service can guarantee perfect security.'],
      ['Your choices', 'You can update account profile information in the app, disconnect wallets where supported, and contact us about access, correction, deletion, or other privacy requests. Some records, including public blockchain data and transaction records required for compliance, may not be removable.'],
      ['Children', 'Pokoin is not intended for children under 13. If you believe a child has provided personal information to us, contact us so we can review and take appropriate action.'],
      ['Changes to this policy', 'We may update this Privacy Policy as Pokoin, Card Reserve, PokoinPoS, PKN, wPKN, and marketplace features evolve. The updated version will be posted on this page with a new effective date.'],
      ['Contact', 'For privacy questions or requests, contact Pokoin at contact@pokoin.com.'],
    ],
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
