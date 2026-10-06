import type { RouterCandidate } from '../../api/modelRouter';

/**
 * 虚拟模型编辑的优先级纯函数与 uid 工具（m-36：从 ModelRouterPage 抽出）。
 * ModelRouterPage 与 VirtualModelEditModal 共用同一份排序语义。
 */

/**
 * 编辑期的候选：在 RouterCandidate 之上挂一个仅存在于前端的 uid。
 * 候选 id 会随输入实时变化、priority 会因归位而重排，二者都不能当 React key；
 * uid 在候选被创建时确定，重排后随数据一起移动，输入焦点才不会跟错行。
 * 保存时按字段显式映射，uid 不会进入请求体。
 */
export type EditCandidate = RouterCandidate & { uid: string };

let uidSeq = 0;
export const nextUid = () => `c${++uidSeq}`;

/** 候选 id：未手填时按 provider:model 生成 */
export function autoCandidateId(c: RouterCandidate): string {
  return c.id && !c.id.includes(':') ? c.id : `${c.provider}:${c.model || 'model'}`;
}

/**
 * 优先级升序重排（与 orderCandidates 的实际取用顺序一致）。
 * priority 相同时按 id 稳定排序，避免不同优先级相撞时表格抖动。
 */
export function sortByPriority<T extends RouterCandidate>(list: T[]): T[] {
  return list.slice().sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));
}

/** 重排后把 priority 归一为 1..n，保证新增候选不会与既有值相撞 */
export function renumberPriority<T extends RouterCandidate>(list: T[]): T[] {
  return list.map((c, i) => (c.priority === i + 1 ? c : { ...c, priority: i + 1 }));
}

/**
 * 归位：按优先级升序排列。
 * 出现重复或非法值（清空得到 0）时归一为 1..n，
 * 否则保留用户设定的稀疏值（如 1/5/10）。
 */
export function settlePriority<T extends RouterCandidate>(list: T[]): T[] {
  const sorted = sortByPriority(list);
  const dirty =
    new Set(sorted.map((c) => c.priority)).size !== sorted.length ||
    sorted.some((c) => !Number.isFinite(c.priority) || c.priority <= 0);
  return dirty ? renumberPriority(sorted) : sorted;
}

export function emptyCandidate(provider: string): EditCandidate {
  return {
    uid: nextUid(),
    id: '',
    provider,
    model: '',
    priority: 1,
    weight: 1,
    maxRpm: null,
    enabled: true,
  };
}

/** 编辑期虚拟模型形态：候选带 uid（见上 EditCandidate）。 */
export type EditVirtual = Omit<import('../../api/modelRouter').VirtualModel, 'candidates'> & { candidates: EditCandidate[] };

export function emptyVirtual(defaultProvider = 'trae'): EditVirtual {
  return {
    id: '',
    enabled: true,
    description: '',
    strategy: 'priority',
    contextWindow: null,
    candidates: [emptyCandidate(defaultProvider)],
    failover: { maxAttempts: 3, switchOn: ['rate_limit', 'model', '5xx', 'network', 'other'], cooldownMs: 20000 },
  };
}

/** 判定「焦点交给了真正的交互控件」：用于区分用户主动切换与点空白处的被动失焦 */
export const USER_TARGET = 'input,select,textarea,button,a[href],[tabindex]:not([tabindex="-1"])';
