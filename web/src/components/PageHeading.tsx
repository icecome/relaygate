import { useLocation } from 'react-router-dom';
import { pageMeta } from '../lib/nav';

/**
 * 页面标题栏。由路由自动推导，各页面无需自报身份。
 *
 * 三级信息分层表达：
 *   子栏名（22px，页面级标题） —— 我是谁
 *   栏目名（12px，面包屑前缀） —— 我在哪一区
 *   职责说明（12px，右侧）     —— 这一区是干什么的
 *
 * 数据源与侧栏 / SectionTabs 同源（nav.ts），导航文案改动会同步到这里。
 */
export default function PageHeading() {
  const { pathname } = useLocation();
  const { group, label, seg } = pageMeta(pathname);

  // 无子栏（概览）：栏目名即页面名，不重复面包屑
  const crumb = seg ? group.label : null;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
      <h1 className="text-page flex items-baseline gap-2 min-w-0">
        {crumb && (
          <span className="text-aux font-medium text-ink-faint tracking-normal">{crumb}</span>
        )}
        <span className="truncate">{label}</span>
      </h1>
      <p className="text-aux text-ink-faint m-0">{group.sub}</p>
    </div>
  );
}
