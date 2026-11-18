import { POKOIN_CHAIN_ID, POKOIN_RPC } from './wallet-chain.js';

const PRIVACY_EFFECTIVE = 'Effective October 23, 2026';

/**
 * What the Pokoin Sniper Chrome extension collects, how it handles, stores and shares it.
 * Chrome Web Store review (Purple Nickel) requires every one of those four parts; keep this
 * in step with the extension's network calls and chrome.storage keys.
 */
const EXTENSION_PRIVACY_SECTIONS = [
  ['Pokoin Sniper extension: data it collects', 'Pokoin Sniper – TCG Card Prices & Deal Finder (Chrome Web Store item cfbhlgeehdneeplhlelajdmhndkigbhc) collects only what it needs to identify cards and show their prices. (1) Account and authentication data: when you sign in with your Pokoin account, the extension receives your Pokoin user ID, email address, display name, membership (Pokoin Silver) status, and Firebase authentication tokens (a short-lived ID token and a refresh token). (2) Website content of supported card pages: on Vinted, eBay, Cardmarket and CardTrader item pages it reads the page address, the listing title, description and brand, the card details shown on the page, and the addresses of the listing photos. On Instagram and Facebook it reads a page only when you click Scan visible tab. (3) Images: up to four photos of the listing you are viewing, and, when you click Scan visible tab, a screenshot of the visible part of the tab. (4) Text you enter or select in the extension, such as card names, collector numbers and clue chips. (5) Actions you take in the extension: cards you add to or remove from your watchlist, cards you hide, the position of the on-page panel, and your settings. The extension looks at the address of the active tab only to tell whether it is a supported card page; it does not record or upload your browsing history. It does not collect passwords for other sites, payment or financial information, health information, personal messages, location, keystrokes, or your marketplace account data.'],
  ['Pokoin Sniper extension: how it uses and handles data', 'The extension uses this data only to provide its single purpose: recognising trading cards in listings and showing their prices, sales and best deals. Listing photos are downscaled in your browser and sent over HTTPS to the Pokoin card-recognition service at api.pokoin.com, which processes them in memory to return the matching cards and does not save them. If that service is unavailable, Pokémon cards are recognised on your own device instead. Visible-tab screenshots are processed only on your device and are never uploaded. Card names, collector numbers, expansions and search text are sent to api.pokoin.com to look up matching cards, prices and recent sales. When you are signed in and open a Cardmarket single-card product page, the extension sends that page address, its title, the card details shown on it and the Pokoin card it matched to Pokoin, linked to your account, so we can improve card matching and price data. Watchlist actions send the card ID and whether you added or removed it, linked to your account. Your ID token is sent with requests to Pokoin to confirm your account and Silver access; your refresh token is sent only to Google Firebase (securetoken.googleapis.com) to renew your sign-in. We do not use this data for advertising, to build profiles for other purposes, or to determine creditworthiness, and people at Pokoin do not read it except with your permission, for security or abuse investigations, to comply with the law, or in aggregated form.'],
  ['Pokoin Sniper extension: how it stores data', 'On your device, the extension keeps its data in Chrome extension storage. Your refresh token and your settings (scan game, panel position and collapsed state, feature settings, usage counters) stay in local extension storage until you sign out or remove the extension. Cards you hide on a listing are remembered on your device for 3 days. Your ID token, side-panel state, a short diagnostic log of recent extension events, and Cardmarket observations waiting to be sent are kept in session storage, which Chrome clears when you close the browser. The diagnostic log never leaves your device. On Pokoin servers, your watchlist and the Cardmarket observations linked to your account are stored with your Pokoin account until you delete them or ask us to delete your account. Listing photos are not stored. Our servers keep standard request logs (such as time, IP address and response status) for security and abuse prevention and delete them when they are no longer needed for that purpose. All data is sent over encrypted HTTPS connections, and access to Pokoin servers is restricted to authorised staff.'],
  ['Pokoin Sniper extension: how it shares data', 'We do not sell or rent data collected by the extension, and we do not share it with advertisers, data brokers or information resellers. We share it only with service providers that run Pokoin on our behalf and may use it only for that: Google Firebase for sign-in and authentication, Cloudflare for network delivery and security, and the hosting providers that run the Pokoin API and card-recognition service. The extension loads pages and photos from the marketplace you are viewing (Vinted, eBay, Cardmarket, CardTrader, Instagram or Facebook) the same way your browser already does, and does not send them any other data about you. Clicking a Best Deal or marketplace link opens that marketplace in a new tab. We may also disclose data when required by law, to protect users and prevent fraud or abuse, or as part of a business transfer, in which case this policy continues to apply.'],
  ['Pokoin Sniper extension: Chrome Web Store User Data Policy', 'The use of information received through the extension complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.'],
  ['Pokoin Sniper extension: your choices', 'The on-page panel and scans run only on supported card marketplace pages. Removing the extension from Chrome deletes everything it stored on your device. To access, correct or delete data stored on Pokoin servers, including your watchlist and Cardmarket observations, email contact@pokoin.com.'],
];

/** Copy for the static Site pages (/docs, /contact, /privacy, /extension/privacy, /earn, /whitepaper, /health); shared by both UIs. */
export const SITE_PAGES = {
  '/docs': {
    eyebrow: 'Network',
    title: 'Host a node',
    lead: 'PokoinPoS is permissioned proof-of-stake. Public RPC and explorer stay off this SPA.',
    body: [
      ['Overview', 'Peers vote, marketplace API sits in front of Postgres, PKN is the native gas.'],
      ['Run a node', 'Docker peer images live in the chain repo. Do not point api.pokoin.com at a new region until restore is verified.'],
      ['Wallets', `Injected wallets use chain ID ${POKOIN_CHAIN_ID} and ${POKOIN_RPC}.`],
      ['Health', 'Use /health here or the live RPC. Explorer is Caddy, not Vercel.'],
      ['Operators', 'Two bootstrap peers are live. Hosting a node is documented; new operators are approved — there is no open intake form.'],
      ['Security pass', 'The 28 May 2026 security pass is an official PokoinPoS report from Go-native tools (/audit/PokoinPOS_Official_Security_Audit_2026-05-28.pdf). It is not a paid third-party audit.'],
    ],
  },
  '/contact': {
    eyebrow: 'Support',
    title: 'Contact',
    lead: 'Email contact@pokoin.com. Forum is public for collectors.',
    body: [['Forum', 'Open /forum to read. Posting needs a signed-in account.']],
  },
  '/privacy': {
    eyebrow: PRIVACY_EFFECTIVE,
    title: 'Privacy Policy',
    lead: 'This policy explains how Pokoin collects, uses, stores and shares information across pokoin.com, Card Reserve marketplace features, Pokoin accounts, wallet tools, PokoinScan, PKN, wPKN, the Pokoin Sniper browser extension, and related ecosystem services.',
    body: [
      ['Information we collect', 'Pokoin may collect account details such as your email address, display name, username, wallet address, profile image, marketplace activity, forum posts, support messages, and settings you choose to save. When you buy, sell, top up, withdraw, or connect a wallet, we process the information needed to complete that action.'],
      ['Payments and wallet activity', 'Payment processing is handled by third-party payment providers such as Stripe. Pokoin does not store full card numbers. Public blockchain transactions, wallet addresses, balances, validator activity, and reserve information may be visible on-chain or through PokoinScan because blockchains are public by design.'],
      ['How we use information', 'We use information to provide accounts, wallet linking, marketplace listings, checkout, PKN balance features, withdrawals, fraud prevention, customer support, network status, security monitoring, and product improvements. We may also use contact information to send account, verification, transaction, or security messages.'],
      ['Service providers', 'Pokoin relies on service providers for hosting, authentication, storage, email delivery, payments, analytics, marketplace operations, and blockchain infrastructure. These providers may process information only as needed to deliver their services to Pokoin and its users.'],
      ['Cookies and local storage', 'The site may use cookies, browser storage, wallet provider state, Firebase session data, and similar technologies to keep you signed in, secure your account, remember preferences, and operate the app. You can control some storage through your browser settings, but disabling it may break account or wallet features.'],
      ['Sharing and disclosures', 'We do not sell personal information. We may disclose information when required by law, to protect users and the network, to prevent fraud or abuse, to complete marketplace transactions, or as part of a business transfer involving the Pokoin ecosystem.'],
      ['Retention and security', 'We keep information for as long as needed to provide the service, meet legal and accounting requirements, resolve disputes, prevent abuse, and maintain network integrity. We use technical and organizational safeguards, but no online service can guarantee perfect security.'],
      ['Your choices', 'You can update account profile information in the app, manage email preferences at /email-preferences, disconnect wallets where supported, and contact us about access, correction, deletion, or other privacy requests. Some records, including public blockchain data and transaction records required for compliance, may not be removable.'],
      ...EXTENSION_PRIVACY_SECTIONS,
      ['Children', 'Pokoin is not intended for children under 13. If you believe a child has provided personal information to us, contact us so we can review and take appropriate action.'],
      ['Changes to this policy', 'We may update this Privacy Policy as Pokoin, Card Reserve, PokoinPoS, PKN, wPKN, the Pokoin Sniper extension, and marketplace features evolve. The updated version will be posted on this page with a new effective date.'],
      ['Contact', 'For privacy questions or requests, contact Pokoin at contact@pokoin.com.'],
    ],
  },
  '/extension/privacy': {
    eyebrow: PRIVACY_EFFECTIVE,
    title: 'Pokoin Sniper Privacy Policy',
    lead: 'This policy explains what user data the Pokoin Sniper Chrome extension collects, how it uses and handles that data, how it stores it, and who it shares it with. Your Pokoin account and the pokoin.com website are covered by the full Pokoin Privacy Policy at pokoin.com/privacy.',
    body: [
      ...EXTENSION_PRIVACY_SECTIONS,
      ['Children', 'Pokoin Sniper is not intended for children under 13. If you believe a child has provided personal information to us, contact us so we can review and take appropriate action.'],
      ['Changes to this policy', 'We will post any update to this policy on this page with a new effective date before the extension starts handling data in a new way.'],
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

/** The page for a pathname; unknown paths read as /docs. */
export function sitePage(pathname) {
  const path = String(pathname || '').replace(/\/$/, '') || '/docs';
  return { path, page: SITE_PAGES[path] || SITE_PAGES['/docs'] };
}

/** One eth_chainId probe against the public RPC, as the status line /health shows. */
export async function probeRpc() {
  try {
    const response = await fetch(POKOIN_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const data = await response.json();
    const id = Number.parseInt(data.result, 16);
    return Number.isFinite(id) ? `RPC ok · chain ${id}` : 'RPC answered without a chain id.';
  } catch {
    return 'RPC unreachable from this browser.';
  }
}
