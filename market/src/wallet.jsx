import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export const POKOIN_CHAIN_ID = 26062026;
export const POKOIN_RPC = 'https://rpc.pokoin.com/rpc';
export const SWAP_ROUTER = '0x0000000000000000000000000000000000002606';
export const SWAP_PREFIX = 'pokoinswap:v1:';
const ADDRESS_KEY = 'pokoin.walletAddress';

function hexChain(id) {
  return `0x${Number(id).toString(16)}`;
}

async function rpc(method, params = []) {
  const response = await fetch(POKOIN_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || 'RPC failed');
  }
  return data.result;
}

function fromWei(hex) {
  if (!hex) {
    return 0;
  }
  try {
    return Number(BigInt(hex)) / 1e18;
  } catch (_) {
    return 0;
  }
}

const WalletContext = createContext({
  address: '',
  balance: 0,
  chainId: null,
  ready: false,
  connect: async () => {},
  disconnect: () => {},
});

export function WalletProvider({ children }) {
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState(0);
  const [chainId, setChainId] = useState(null);
  const [ready, setReady] = useState(false);

  async function refresh(nextAddress) {
    const account = (nextAddress || address || '').toLowerCase();
    if (!account) {
      setBalance(0);
      return;
    }
    try {
      const [wei, id] = await Promise.all([
        rpc('eth_getBalance', [account, 'latest']),
        rpc('eth_chainId'),
      ]);
      setBalance(fromWei(wei));
      setChainId(Number.parseInt(id, 16));
    } catch (_) {
      setBalance(0);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem(ADDRESS_KEY) || '';
    if (saved) {
      setAddress(saved);
      refresh(saved).finally(() => setReady(true));
    } else {
      setReady(true);
    }
  }, []);

  const value = useMemo(() => ({
    address,
    balance,
    chainId,
    ready,
    async connect() {
      const ethereum = window.ethereum;
      if (!ethereum?.request) {
        throw new Error('Install MetaMask or another injected wallet.');
      }
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      const next = String(accounts?.[0] || '').toLowerCase();
      if (!next) {
        throw new Error('No account returned.');
      }
      await switchToPokoin();
      localStorage.setItem(ADDRESS_KEY, next);
      setAddress(next);
      await refresh(next);
    },
    disconnect() {
      localStorage.removeItem(ADDRESS_KEY);
      setAddress('');
      setBalance(0);
    },
  }), [address, balance, chainId, ready]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  return useContext(WalletContext);
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
    throw new Error('Install MetaMask.');
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

export function poolIdFor(asset) {
  const code = String(asset || '').toUpperCase();
  if (!code || code === 'PKN') {
    return '';
  }
  return code === 'WPKN' ? 'PKN-WPKN' : `${code}-PKN`;
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
    throw new Error('Install MetaMask.');
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
    throw new Error('Install MetaMask.');
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
