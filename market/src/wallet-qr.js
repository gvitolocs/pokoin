/** Pokoin payment QR payloads.
 *
 * Two shapes live in the wild:
 * - Site transfers:   `pokoin:u/<username>`            (+ `?a=<whole PKN>`)
 * - On-chain (EIP-681): `ethereum:<address>@26062026`  (+ `?value=<wei>`)
 *
 * Plain `0x…` addresses and bare usernames are accepted when scanning so
 * third-party wallet QRs still work. Scanning NEVER implies a transfer —
 * callers only get parsed fields to prefill the Send sheet.
 */

const SITE_RE = /^pokoin:u\/([a-zA-Z0-9]{3,32})(?:\?a=(\d{1,9}))?$/;
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
  if (!whole) return `pokoin:u/${name}`;
  if (!/^\d{1,9}$/.test(whole) || Number(whole) <= 0) return null;
  return `pokoin:u/${name}?a=${Number(whole)}`;
}

/** Parse scanned QR text into Send-sheet fields. Never represents a
 * committed transfer — the caller prefills and waits for an explicit send. */
export function parseScannedQr(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const site = SITE_RE.exec(raw);
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
