// Web-only stand-in for expo-secure-store (demo use; stored in localStorage).
const P = 'securestore:';
export async function getItemAsync(k) { return localStorage.getItem(P + k); }
export async function setItemAsync(k, v) { localStorage.setItem(P + k, v); }
export async function deleteItemAsync(k) { localStorage.removeItem(P + k); }
export function getItem(k) { return localStorage.getItem(P + k); }
export function setItem(k, v) { localStorage.setItem(P + k, v); }
export async function isAvailableAsync() { return true; }
export const AFTER_FIRST_UNLOCK = 0, WHEN_UNLOCKED = 1;
