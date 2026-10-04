import { createStore, useStore } from '../lib/store';

const KEY_STORE_KEY = 'trae_key';
const AUTH_STORE = createStore({
  // sessionStorage：标签页生命周期内保留，关闭浏览器即清除（XSS 残留窗口小于 localStorage）
  key: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY_STORE_KEY) || '' : '',
});

export function useAuth() {
  return useStore(AUTH_STORE);
}

export function setKey(key: string) {
  AUTH_STORE.set({ key });
  if (key) sessionStorage.setItem(KEY_STORE_KEY, key);
  else sessionStorage.removeItem(KEY_STORE_KEY);
}

export function clearKey() {
  setKey('');
}
