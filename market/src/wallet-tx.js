// Browser-wallet (EIP-1193) calls for PokoinPoS: network switch, PKN sends and
// PokoinSwap transactions. No UI framework — wallet.jsx (React) and the Solid
// wallet store both use these.

import {
  POKOIN_CHAIN_ID,
  POKOIN_RPC,
  WALLET_ADDRESS_KEY,
  fetchWalletBalance,
} from './wallet-chain.js';

export { POKOIN_CHAIN_ID, POKOIN_RPC, WALLET_ADDRESS_KEY, fetchWalletBalance };
export const SWAP_ROUTER = '0x0000000000000000000000000000000000002606';
export const SWAP_PREFIX = 'pokoinswap:v1:';

function hexChain(id) {
  return `0x${Number(id).toString(16)}`;
}

export function shortAddress(address) {
  const value = String(address || '');
  if (value.length < 12) {
    return value || '—';
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function utf8Hex(text) {
  return `0x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function switchToPokoin() {
  const ethereum = window.ethereum;
  if (!ethereum?.request) {
    throw new Error('Connect an EVM wallet — browser wallet, Ledger, or similar.');
  }
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChain(POKOIN_CHAIN_ID) }],
    });
  } catch (err) {
    if (err?.code === 4902) {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChain(POKOIN_CHAIN_ID),
          chainName: 'PokoinPoS',
          nativeCurrency: { name: 'PKN', symbol: 'PKN', decimals: 18 },
          rpcUrls: [POKOIN_RPC],
          blockExplorerUrls: ['https://explorer.pokoin.com'],
        }],
      });
      return;
    }
    throw err;
  }
}

/** Ask the browser wallet for an account and move it to PokoinPoS; returns the lowercased address. */
export async function requestWalletAccount() {
  const ethereum = window.ethereum;
  if (!ethereum?.request) {
    throw new Error('No wallet found. Connect an EVM wallet — browser wallet, Ledger, or similar.');
  }
  const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
  const next = String(accounts?.[0] || '').toLowerCase();
  if (!next) {
    throw new Error('No account returned.');
  }
  await switchToPokoin();
  return next;
}

export function poolIdFor(asset) {
  const code = String(asset || '').toUpperCase();
  if (!code || code === 'PKN') {
    return '';
  }
  return code === 'WPKN' ? 'PKN-WPKN' : `${code}-PKN`;
}

/** GET /api/swap-pools rows → [{ id, asset }], WPKN always listed. */
export function swapPoolsOf(data) {
  const rows = Array.isArray(data) ? data : (data?.pools || data?.items || []);
  const mapped = rows.map((row) => {
    const id = String(row.id || row.poolId || row.pool_id || '');
    let asset = String(row.otherAsset || row.asset || row.quote || row.assetB || '').toUpperCase();
    if (!asset && id) {
      asset = id.replace(/^PKN-/, '').replace(/-PKN$/, '').toUpperCase();
    }
    if (asset === 'PKN') {
      asset = '';
    }
    return { id: id || poolIdFor(asset), asset: asset || '' };
  }).filter((row) => row.asset);
  if (!mapped.some((row) => row.asset === 'WPKN')) {
    mapped.push({ id: poolIdFor('WPKN'), asset: 'WPKN' });
  }
  return mapped;
}

export function toWeiHex(amount) {
  const [whole, frac = ''] = String(amount || '0').trim().split('.');
  const frac18 = `${frac}000000000000000000`.slice(0, 18);
  const wei = BigInt(whole || '0') * (10n ** 18n) + BigInt(frac18 || '0');
  return `0x${wei.toString(16)}`;
}

export async function sendPkn({ from, to, amount }) {
  const ethereum = window.ethereum;
  if (!ethereum?.request) {
    throw new Error('Connect an EVM wallet — browser wallet, Ledger, or similar.');
  }
  const dest = String(to || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) {
    throw new Error('Enter a 0x address.');
  }
  await switchToPokoin();
  return ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: dest,
      value: toWeiHex(amount),
    }],
  });
}

export async function sendSwapTransaction({ from, quote, poolId, assetIn, assetOut, amountIn }) {
  const ethereum = window.ethereum;
  if (!ethereum?.request) {
    throw new Error('Connect an EVM wallet — browser wallet, Ledger, or similar.');
  }
  await switchToPokoin();
  const amountOut = Number(quote?.amountOut || 0);
  if (!Number.isFinite(amountOut) || amountOut <= 0) {
    throw new Error('Quote returned no output.');
  }
  const resolvedPool = String(quote?.poolId || poolId || '');
  const wpkn = /WPKN/i.test(resolvedPool);
  const payload = {
    action: 'amm_swap',
    poolId: resolvedPool,
    assetIn: quote?.assetIn || assetIn,
    assetOut: quote?.assetOut || assetOut,
    amountIn: Number(quote?.amountIn || amountIn),
    minAmountOut: wpkn ? Math.floor(amountOut) : Math.floor(amountOut * 995 / 1000),
  };
  return ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: SWAP_ROUTER,
      value: '0x0',
      data: utf8Hex(`${SWAP_PREFIX}${JSON.stringify(payload)}`),
    }],
  });
}
