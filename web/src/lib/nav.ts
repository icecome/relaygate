/**
 * 导航结构：4 个一级栏目，每栏目下若干子栏。
 * 一级栏目的 path 与其首个子栏同址（如 /accounts 即 /accounts/all），
 * 子栏为真实 URL，便于分享链接、前进后退与刷新保持。
 */
export interface NavChild {
  /** 子栏路径片段，拼在栏目 path 之后 */
  seg: string;
  label: string;
}

export interface NavGroup {
  id: string;
  label: string;
  /** 一级栏目路径 */
  path: string;
  /** 顶栏副标题 */
  sub: string;
  children: NavChild[];
}

export const NAV: NavGroup[] = [
  {
    id: 'overview',
    label: '概览',
    path: '/',
    sub: '账号池健康度与今日进度',
    children: [],
  },
  {
    id: 'accounts',
    label: '账号',
    path: '/accounts',
    sub: '凭据池、平台分组与访问密钥',
    children: [
      { seg: 'all', label: '全部账号' },
      { seg: 'trae', label: 'Trae' },
      { seg: 'wb', label: 'WorkBuddy' },
      { seg: 'keys', label: '访问密钥' },
    ],
  },
  {
    id: 'stats',
    label: '统计',
    path: '/stats',
    sub: 'Token 用量、积分消耗与请求日志',
    children: [
      { seg: 'token', label: 'Token 用量' },
      { seg: 'credit', label: '积分消耗' },
      { seg: 'models', label: '模型与虚拟模型' },
      { seg: 'logs', label: '请求日志' },
    ],
  },
  {
    id: 'settings',
    label: '设置',
    path: '/settings',
    sub: '运行状态、定时任务与配置',
    children: [
      { seg: 'run', label: '运行状态' },
      { seg: 'tasks', label: '定时任务' },
      { seg: 'notify', label: '通知与备份' },
      { seg: 'config', label: '配置' },
    ],
  },
];

/** 路径 → 一级栏目。按 path 长度降序匹配，避免 '/' 命中一切。 */
export function groupOf(pathname: string): NavGroup {
  const hit = NAV.filter((g) => g.path !== '/').find(
    (g) => pathname === g.path || pathname.startsWith(g.path + '/'),
  );
  return hit ?? NAV[0];
}

/** 路径 → 当前子栏 seg。未指定或非法时回落首个子栏。 */
export function childOf(pathname: string, group: NavGroup): string | null {
  if (!group.children.length) return null;
  const rest = pathname.slice(group.path.length).replace(/^\//, '');
  const seg = rest.split('/')[0];
  return group.children.some((c) => c.seg === seg) ? seg : group.children[0].seg;
}

/** 一级栏目 + 子栏 → 实际 URL。概览无子栏，直接返回其路径。 */
export function tabPath(group: NavGroup, seg: string): string {
  return group.children.length ? `${group.path}/${seg}` : group.path;
}
