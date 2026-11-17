/**
 * 界面密度偏好。
 *
 * ## 为什么是 localStorage 而凭据不是
 *
 * 这里只存一个枚举（comfortable / compact），不含任何凭据、账号、密钥，
 * 也没有可被利用的信息。放在 localStorage 是为了跨标签页、跨会话保持 ——
 * 密度是「我习惯怎么看这张表」，每次重开都要重设等于没做。
 *
 * 管理的登录密钥仍然只走 sessionStorage（见 shared/api/auth.ts）：
 * 那个值一旦落盘，面板被旁路访问时等于长期钥匙。
 *
 * ## 为什么挂在 <html> 上而不是根组件
 *
 * 密度要影响全局令牌（--rg-row-h 等），令牌定义在 :root；
 * 只有把属性挂在 <html> 才能命中 `html[data-density='compact']`。
 * 同时这样 CSS 先行、React 后到也不闪：首帧就按存储值渲染。
 */
import { createStore, useStore } from '../../lib/store';

const KEY = 'rg-density';

export type Density = 'comfortable' | 'compact';

function read(): Density {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'compact' ? 'compact' : 'comfortable';
  } catch {
    // 隐私模式 / 存储被禁用时兜底到默认密度，不抛错打断启动
    return 'comfortable';
  }
}

/** 把密度写到 <html data-density>；CSS 令牌据此切换行高与内边距。 */
export function applyDensity(d: Density) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', d);
}

const DENSITY_STORE = createStore<{ density: Density }>({ density: read() });

// 模块加载即应用一次：早于 React 渲染，避免首屏按默认密度画完再跳
applyDensity(DENSITY_STORE.get().density);

export function useDensity() {
  return useStore(DENSITY_STORE);
}

export function setDensity(d: Density) {
  DENSITY_STORE.set({ density: d });
  applyDensity(d);
  try {
    localStorage.setItem(KEY, d);
  } catch {
    /* 存不了就只在本次会话内生效，不打断操作 */
  }
}

export function toggleDensity() {
  setDensity(DENSITY_STORE.get().density === 'compact' ? 'comfortable' : 'compact');
}
