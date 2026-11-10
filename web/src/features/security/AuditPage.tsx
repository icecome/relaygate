/**
 * 安全审计页（/audit）。
 * 后端 GET /v1/admin/audit 早已实现（admin-security.js），但 UI 一直没有入口：
 * 密钥 reveal、凭据导出、目录 lifecycle 等敏感操作都会写审计，却无人可见。
 * 本页补上只读视图——审计的语义是「事后可追溯」，不做任何写操作。
 */
import { useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { getAuditLog } from '../../shared/api/admin';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatTime } from '../../shared/lib/format';
import {
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';

type ResultFilter = 'all' | 'ok' | 'allow' | 'deny' | 'error';

/**
 * 后端结果枚举 → 展示文案。
 *
 * ok 与 allow 是两个不同取值，不能映射成同一个词：此前两者都叫「允许」，
 * 而筛选项只发 result=ok，于是 allow 的行在「全部」里显示「允许」、
 * 切到「允许」筛选后又消失 —— 用户会以为数据丢了。
 */
const RESULT_LABEL: Record<string, string> = {
  ok: '成功',
  allow: '允许',
  deny: '拒绝',
  error: '错误',
};

/** 审计动作的中文说明。未知动作直接原样展示，不编造含义。 */
const ACTION_LABEL: Record<string, string> = {
  'key.reveal': '查看密钥明文',
  'key.create': '创建密钥',
  'key.reset': '重置密钥',
  'credentials.export': '导出凭据',
  'backup.restore': '恢复备份',
  'catalog.lifecycle': '修改模型生命周期',
};

/** 拉取上限；文案与查询共用同一个常量，避免改一处漂一处。 */
const AUDIT_LIMIT = 200;

function actionLabel(action: string | null | undefined): string {
  if (!action) return '—';
  return ACTION_LABEL[action] ?? action;
}

function resultChip(result: string | null | undefined) {
  switch (result) {
    case 'ok':
      return <Chip tone="ok" dot="dot-ok">成功</Chip>;
    case 'allow':
      return <Chip tone="ok" dot="dot-ok">允许</Chip>;
    case 'deny':
      return <Chip tone="warn" dot="dot-cool">拒绝</Chip>;
    case 'error':
      return <Chip tone="danger" dot="dot-error">错误</Chip>;
    default:
      return <Chip tone="neutral">{result ? (RESULT_LABEL[result] ?? result) : '—'}</Chip>;
  }
}

export default function AuditPage() {
  const { key } = useAuth();
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');

  const audit = useAsyncData(
    (signal) => getAuditLog({ result: resultFilter === 'all' ? undefined : resultFilter, limit: AUDIT_LIMIT }, key, signal),
    [key, resultFilter],
    { enabled: !!key },
  );

  const rows = useMemo(() => audit.data?.data ?? [], [audit.data]);
  const actions = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.action) s.add(r.action);
    return [...s].sort();
  }, [rows]);

  return (
    <PageShell
      title="审计日志"
      description="谁在什么时候查看过密钥明文、导出过凭据——事后可追溯，不可在此修改"
      actions={
        <Segmented
          ariaLabel="结果筛选"
          value={resultFilter}
          onChange={setResultFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'ok', label: '成功' },
            { value: 'allow', label: '允许' },
            { value: 'deny', label: '拒绝' },
            { value: 'error', label: '错误' },
          ]}
        />
      }
      toolbar={
        <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
          共 {rows.length} 条 · 涉及 {actions.length} 类动作
        </span>
      }
    >
      <Stack>
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}

        <Panel
          title="审计事件"
          description={`最近 ${rows.length} 条（最多拉取 ${AUDIT_LIMIT} 条）`}
          flush
        >
          {audit.loading && !audit.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <EmptyState
              label="还没有审计记录"
              hint="查看密钥明文、导出凭据等敏感操作会记录在这里；本页只读，不可修改。"
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th">时间</th>
                  <th className="th">动作</th>
                  <th className="th">对象</th>
                  <th className="th">结果</th>
                  <th className="th">原因</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id ?? i} className="row-hover">
                    <td className="td td-mono whitespace-nowrap">{formatTime(r.ts)}</td>
                    <td className="td">
                      <span title={r.action ?? undefined}>{actionLabel(r.action)}</span>
                    </td>
                    <td className="td font-mono text-aux break-all">{r.resource || '—'}</td>
                    <td className="td">{resultChip(r.result)}</td>
                    <td className="td text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                      {r.reason || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </Stack>
    </PageShell>
  );
}