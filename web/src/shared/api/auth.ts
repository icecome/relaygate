/**
 * 认证状态。沿用原有语义：密钥存sessionStorage，
 * 标签页生命周期内有效，关闭浏览器即清除。
 */
import { createStore, useStore } from '../../lib/store';

const KEY_STORE_KEY = 'trae_key';

const AUTH_STORE = createStore({
  key: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY_STORE_KEY) || '' : '',
});

export function useAuth() {
  return useStore(AUTH_STORE);
}

export function getKey(): string {
  return AUTH_STORE.get().key;
}

export function setKey(key: string) {
  AUTH_STORE.set({ key });
  if (key) sessionStorage.setItem(KEY_STORE_KEY, key);
  else sessionStorage.removeItem(KEY_STORE_KEY);
}

export function clearKey() {
  setKey('');
}