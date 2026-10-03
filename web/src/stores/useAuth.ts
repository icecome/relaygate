import { createStore, useStore } from '../lib/store';

const KEY_STORE_KEY = 'trae_key';
const AUTH_STORE = createStore({
  key: typeof localStorage !== 'undefined' ? localStorage.getItem(KEY_STORE_KEY) || '' : '',
});

export function useAuth() {
  return useStore(AUTH_STORE);
}

export function setKey(key: string) {
  AUTH_STORE.set({ key });
  if (key) localStorage.setItem(KEY_STORE_KEY, key);
  else localStorage.removeItem(KEY_STORE_KEY);
}

export function clearKey() {
  setKey('');
}