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
  ErrorState,
  LoadingBlock,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';

type ResultFilter = 'all' | 'ok' | 'deny' | 'error';

/** 审计动作的中文说明。未知动作直接原样展示，不编造含义。 */
const ACTION_LABEL: Record<string, string> = {
  'key.reveal': '查看密钥明文',
  'key.create': '创建密钥',
  'key.reset': '重置密钥',
  'credentials.export': '导出凭据',
  'backup.restore': '恢复备份',
  'catalog.lifecycle': '修改模型生命周期',
};

function actionLabel(action: string | null | undefined): string {
  if (!action) return '—';
  return ACTION_LABEL[action] ?? action;
}

function resultChip(result: string | null | undefined) {
  switch (result) {
    case 'ok':
    case 'allow':
      return <Chip tone="ok" dot="dot-ok">允许</Chip>;
    case 'deny':
      return <Chip tone="warn" dot="dot-cool">拒绝</Chip>;
    case 'error':
      return <Chip tone="danger" dot="dot-error">错误</Chip>;
    default:
      return <Chip tone="neutral">{result || '—'}</Chip>;
  }
}

export default function AuditPage() {
  const { key } = useAuth();
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');

  const audit = useAsyncData(
    (signal) => getAuditLog({ result: resultFilter === 'all' ? undefined : resultFilter, limit: 200 }, key, signal),
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
            { value: 'ok', label: '允许' },
            { value: 'deny', label: '拒绝' },
            { value: 'error', label: '错误' },
          ]}
        />
      }
      toolbar={
        <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          共 {rows.length} 条 · 涉及 {actions.length} 类动作
        </span>
      }
    >
      <Stack>
        {audit.error && <ErrorState message={audit.error} onRetry={audit.reload} />}

        <Panel
          title="审计事件"
          description={`最近 ${rows.length} 条（最多拉取 200 条）`}
          flush
        >
          {audit.loading && !audit.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              还没有审计记录。查看密钥明文、导出凭据等敏感操作会记录在这里。
            </div>
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
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
                    <td className="td font-mono text-[12px] whitespace-nowrap" data-label="时间">{formatTime(r.ts)}</td>
                    <td className="td" data-label="动作">
                      <span title={r.action ?? undefined}>{actionLabel(r.action)}</span>
                    </td>
                    <td className="td font-mono text-[11px] break-all" data-label="对象">{r.resource || '—'}</td>
                    <td className="td" data-label="结果">{resultChip(r.result)}</td>
                    <td className="td text-[12px]" style={{ color: 'var(--rg-text-secondary)' }} data-label="原因">
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