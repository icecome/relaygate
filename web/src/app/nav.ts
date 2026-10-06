/**
 * 导航结构：两级分组，对应 RelayGate 真实功能模块。
 *
 * 分组依据后端实际能力划分，不按视觉需要拼凑：
 *   总览   凭据池健康度与运行态
 *   账号   凭据管理、访问密钥
 *   模型   路由编排、模型池状态
 *   统计   用量成本、请求日志
 *   运维   运行状态、定时任务、轮换、通知备份、配置
 *
 * 运维类能力较分散，统一收敛到 /ops 单页，用页内分段切换，
 * 避免侧栏出现过多平级项。
 */
export interface NavItem {
  /** 相对路径 */
  to: string;
  label: string;
  /** 分组内的稳定标识，用于分段控件与埋点 */
  id: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'overview',
    label: '总览',
    items: [{ id: 'overview', to: '/', label: '总览' }],
  },
  {
    id: 'accounts',
    label: '账号',
    items: [
      { id: 'credentials', to: '/credentials', label: '凭据池' },
      { id: 'access-keys', to: '/access-keys', label: '访问密钥' },
    ],
  },
  {
    id: 'models',
    label: '模型',
    items: [
      { id: 'model-router', to: '/model-router', label: '路由与虚拟模型' },
      { id: 'model-pool', to: '/model-pool', label: '模型池状态' },
    ],
  },
  {
    id: 'stats',
    label: '统计',
    items: [
      { id: 'token-stats', to: '/token-stats', label: '用量与成本' },
      { id: 'traffic', to: '/traffic', label: '请求日志' },
    ],
  },
  {
    id: 'ops',
    label: '运维',
    items: [
      { id: 'runtime', to: '/ops', label: '运行状态' },
      { id: 'jobs', to: '/ops/jobs', label: '定时任务' },
      { id: 'rotate', to: '/ops/rotate', label: '账号轮换' },
      { id: 'notify', to: '/ops/notify', label: '通知与备份' },
      { id: 'config', to: '/ops/config', label: '网关配置' },
    ],
  },
];

/** 展平后的全部导航项，供路由判定与标题查询使用。 */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function navItemOf(pathname: string): NavItem {
  // 路径长度降序匹配，避免 /ops 抢走 /ops/config
  const hit = [...NAV_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return hit ?? NAV_ITEMS[0];
}