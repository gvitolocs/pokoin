import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  WALLET_ADDRESS_KEY,
  fetchWalletBalance,
  requestWalletAccount,
} from './wallet-tx.js';

// The chain calls are framework-free (wallet-tx.js); this file keeps the React context.
export {
  POKOIN_CHAIN_ID,
  POKOIN_RPC,
  SWAP_PREFIX,
  SWAP_ROUTER,
  poolIdFor,
  sendPkn,
  sendSwapTransaction,
  shortAddress,
  switchToPokoin,
  toWeiHex,
  utf8Hex,
} from './wallet-tx.js';
const ADDRESS_KEY = WALLET_ADDRESS_KEY;

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
      const next = await fetchWalletBalance(account);
      setBalance(next.balance);
      setChainId(next.chainId);
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
      const next = await requestWalletAccount();
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
