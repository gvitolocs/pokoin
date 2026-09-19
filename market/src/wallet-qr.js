/** Pokoin payment QR payloads.
 *
 * Site transfers use an HTTPS deep link so a phone camera (or the in-app
 * Send scanner) opens the wallet Send sheet with the recipient filled:
 *   `https://pokoin.com/wallet?to=<username>`  (+ `&a=<whole PKN>`)
 *
 * Legacy `pokoin:u/<username>` (+ `?a=`) codes are still parsed.
 *
 * On-chain (EIP-681): `ethereum:<address>@26062026` (+ `?value=<wei>`).
 *
 * Plain `0x…` addresses and bare usernames are accepted when scanning so
 * third-party wallet QRs still work. Scanning NEVER implies a transfer —
 * callers only get parsed fields to prefill the Send sheet.
 */

import { MARKET_ORIGIN } from './punchouts.js';

const SITE_LEGACY_RE = /^pokoin:u\/([a-zA-Z0-9]{3,32})(?:\?a=(\d{1,9}))?$/;
const BARE_USER_RE = /^[a-zA-Z0-9]{3,32}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EIP681_RE = /^ethereum:(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\?(.*))?$/;
const WEI_PER_PKN = 1e18;

/** Build the QR text for a receive code. Returns null when the inputs are
 * incomplete (no username yet, no address, bad amount). */
export function buildReceiveQr({ kind = 'site', username = '', address = '', amount = '' } = {}) {
  if (kind === 'chain') {
    if (!ADDRESS_RE.test(String(address || '').trim())) return null;
    const base = `ethereum:${address.trim()}@26062026`;
    const whole = String(amount || '').trim();
    if (!whole) return base;
    if (!/^\d{1,12}$/.test(whole) || Number(whole) <= 0) return null;
    const wei = BigInt(whole) * BigInt(WEI_PER_PKN);
    return `${base}?value=${wei}`;
  }
  const name = String(username || '').trim();
  if (!BARE_USER_RE.test(name)) return null;
  const whole = String(amount || '').trim();
  const url = new URL('/wallet', MARKET_ORIGIN);
  url.searchParams.set('to', name);
  if (whole) {
    if (!/^\d{1,9}$/.test(whole) || Number(whole) <= 0) return null;
    url.searchParams.set('a', String(Number(whole)));
  }
  return url.toString();
}

/** Parse a /wallet?to=… deep link (absolute or path-only). */
export function parseWalletSendLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let url;
  try {
    if (/^https?:\/\//i.test(raw)) {
      url = new URL(raw);
    } else if (raw.startsWith('/wallet')) {
      url = new URL(raw, MARKET_ORIGIN);
    } else {
      return null;
    }
  } catch (_) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/wallet') return null;
  const to = String(url.searchParams.get('to') || url.searchParams.get('u') || '').trim();
  if (!to) return null;
  const amountRaw = String(url.searchParams.get('a') || url.searchParams.get('amount') || '').trim();
  if (ADDRESS_RE.test(to)) {
    return {
      kind: 'chain',
      recipient: to,
      chainId: '',
      amountPkn: amountRaw && /^\d+(\.\d+)?$/.test(amountRaw) ? String(Number(amountRaw)) : '',
    };
  }
  if (!BARE_USER_RE.test(to)) return null;
  let amountPkn = '';
  if (amountRaw) {
    if (!/^\d{1,9}$/.test(amountRaw) || Number(amountRaw) <= 0) return null;
    amountPkn = String(Number(amountRaw));
  }
  return { kind: 'site', recipient: to, amountPkn };
}

/** Parse scanned QR text into Send-sheet fields. Never represents a
 * committed transfer — the caller prefills and waits for an explicit send. */
export function parseScannedQr(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const link = parseWalletSendLink(raw);
  if (link) return link;

  const site = SITE_LEGACY_RE.exec(raw);
  if (site) {
    return { kind: 'site', recipient: site[1], amountPkn: site[2] ? String(Number(site[2])) : '' };
  }

  const eip = EIP681_RE.exec(raw);
  if (eip) {
    const params = new URLSearchParams(eip[3] || '');
    const value = params.get('value') || '';
    let amountPkn = '';
    if (/^\d{1,30}$/.test(value)) {
      const whole = BigInt(value) / BigInt(WEI_PER_PKN);
      const frac = Number(value) % WEI_PER_PKN;
      amountPkn = frac ? trimDecimals(`${whole}.${String(frac).slice(0, 4)}`) : String(whole);
    }
    return { kind: 'chain', recipient: eip[1], chainId: eip[2] || '', amountPkn };
  }

  if (ADDRESS_RE.test(raw)) {
    return { kind: 'chain', recipient: raw, chainId: '', amountPkn: '' };
  }

  if (BARE_USER_RE.test(raw)) {
    return { kind: 'site', recipient: raw, amountPkn: '' };
  }
  return null;
}

function trimDecimals(value) {
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
