import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const CART_KEY = 'pokoin.cartItems';

function readCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((row) => row && row.id) : [];
  } catch (_) {
    return [];
  }
}

function writeCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items.slice(0, 40)));
}

const CartContext = createContext({
  items: [],
  count: 0,
  totalPkn: 0,
  addItem: () => {},
  setQty: () => {},
  removeItem: () => {},
  clear: () => {},
});

export const CHECKOUT_TAX_RATE = 0.08;
export const CHECKOUT_SHIPPING_PKN = 2000;

export function cartItemFromOffer(card, offer) {
  return {
    id: String(offer?.id || `${card.id}-${offer?.sellerName || 'listing'}`),
    listingId: String(offer?.id || offer?.listingId || ''),
    sellerUid: String(offer?.sellerUid || offer?.seller_uid || ''),
    cardId: String(card.id),
    name: card.name || 'Card',
    image: offer?.cardImageUrl || card.gridImageUrl || card.heroImageUrl || card.imageUrl || '',
    pricePkn: Number(offer?.pricePkn) || 0,
    qty: 1,
    condition: offer?.condition || 'NM',
    language: offer?.language || '',
    sellerName: offer?.sellerName || offer?.sellerDisplayName || 'Pokoin',
    nftAvailable: Boolean(offer?.nftAvailable || offer?.isNftEligible),
    reserveAvailable: Boolean(offer?.reserveAvailable),
    href: card.canonicalPath || `/marketplace/en/cards/${card.id}`,
    card: { id: String(card.id), name: card.name || 'Card' },
  };
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => (typeof window === 'undefined' ? [] : readCart()));

  useEffect(() => {
    writeCart(items);
  }, [items]);

  const value = useMemo(() => {
    const count = items.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
    const subtotalPkn = items.reduce((sum, row) => sum + (Number(row.pricePkn) || 0) * (Number(row.qty) || 0), 0);
    const canNftOnly = items.length > 0 && items.every((row) => row.nftAvailable || row.reserveAvailable);
    return {
      items,
      count,
      subtotalPkn,
      totalPkn: subtotalPkn,
      canNftOnly,
      addItem(next) {
        if (!next?.id) {
          return;
        }
        setItems((current) => {
          const match = current.find((row) => row.id === next.id);
          if (match) {
            return current.map((row) => (
              row.id === next.id ? { ...row, qty: Math.min(99, (Number(row.qty) || 1) + (Number(next.qty) || 1)) } : row
            ));
          }
          return [next, ...current].slice(0, 40);
        });
      },
      setQty(id, qty) {
        const next = Math.max(0, Math.min(99, Number.parseInt(qty, 10) || 0));
        setItems((current) => (
          next < 1
            ? current.filter((row) => row.id !== id)
            : current.map((row) => (row.id === id ? { ...row, qty: next } : row))
        ));
      },
      removeItem(id) {
        setItems((current) => current.filter((row) => row.id !== id));
      },
      clear() {
        setItems([]);
      },
    };
  }, [items]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
