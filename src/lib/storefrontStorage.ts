const CART_KEY = "cosmic-cart";
const WISHLIST_KEY = "cosmic-wishlist";

export function loadCart(validIds: string[]): Record<string, number> {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<string, number> = {};
    for (const id of validIds) {
      if (typeof parsed[id] === "number" && parsed[id] > 0) {
        result[id] = parsed[id];
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCart(cart: Record<string, number>): void {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // ignore storage errors
  }
}

export function loadWishlist(): string[] {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveWishlist(wishlist: string[]): void {
  try {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist));
  } catch {
    // ignore storage errors
  }
}
