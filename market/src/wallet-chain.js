// PokoinPoS chain reads for a connected EVM wallet: balance and chain id
// over JSON-RPC. No React — the React WalletProvider and the Solid header's
// PKN chip read the same saved address and the same RPC.

export const POKOIN_CHAIN_ID = 26062026;
export const POKOIN_RPC = 'https://rpc.pokoin.com/rpc';
export const WALLET_ADDRESS_KEY = 'pokoin.walletAddress';

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

/** `{ balance, chainId }` for a lowercase 0x account; throws when the RPC fails. */
export async function fetchWalletBalance(account) {
  const [wei, id] = await Promise.all([
    rpc('eth_getBalance', [account, 'latest']),
    rpc('eth_chainId'),
  ]);
  return { balance: fromWei(wei), chainId: Number.parseInt(id, 16) };
}

/** The wallet this browser connected last ('' when none). */
export function readWalletAddress() {
  try {
    return localStorage.getItem(WALLET_ADDRESS_KEY) || '';
  } catch (_) {
    return '';
  }
}
