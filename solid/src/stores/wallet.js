import { createSignal } from 'solid-js';
import { WALLET_ADDRESS_KEY, fetchWalletBalance, requestWalletAccount } from '@market/wallet-tx.js';

/**
 * The connected PokoinPoS wallet (market/src/wallet.jsx WalletProvider):
 * the saved address, its chain balance and network. Only the wallet and
 * exchange pages import this; the header chip keeps reading stores/account.js.
 */
const [address, setAddress] = createSignal('');
const [balance, setBalance] = createSignal(0);
const [chainId, setChainId] = createSignal(null);
const [ready, setReady] = createSignal(false);

function readSaved() {
  try {
    return localStorage.getItem(WALLET_ADDRESS_KEY) || '';
  } catch (_) {
    return '';
  }
}

async function refresh(nextAddress) {
  const account = String(nextAddress || address() || '').toLowerCase();
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

let started = false;
/** Read the saved address and its balance once per page load. */
export function startWallet() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const saved = readSaved();
  if (saved) {
    setAddress(saved);
    refresh(saved).finally(() => setReady(true));
  } else {
    setReady(true);
  }
}

export const walletAddress = address;
export const walletBalance = balance;
export const walletChainId = chainId;
export const walletReady = ready;

export async function connectWallet() {
  const next = await requestWalletAccount();
  try {
    localStorage.setItem(WALLET_ADDRESS_KEY, next);
  } catch (_) {
    /* private mode: connected for this page only */
  }
  setAddress(next);
  await refresh(next);
}

export function disconnectWallet() {
  try {
    localStorage.removeItem(WALLET_ADDRESS_KEY);
  } catch (_) {
    /* private mode */
  }
  setAddress('');
  setBalance(0);
}
