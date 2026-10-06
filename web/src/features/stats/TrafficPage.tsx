/**
 * 请求日志页：网关转发日志分页检索、SSE 调试记录与一键测试请求。
 *
 * 真实语义：
 *   - /v1/admin/traffic 后端已实现分页（page / totalPages / total），页面直接使用；
 *   - /v1/admin/debug/sse 接口名为 sse，实际读取落盘JSONL 文件，不是实时推送，
 *     页面如实标注，避免运维误判。
 */
import { useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  getSseDebug,
  getTraffic,
  testChat,
  type TrafficResponse,
} from '../../shared/api/admin';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatCost, formatDuration, formatNumber, formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  Field,
  LoadingBlock,
  MetricGrid,
  Note,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';

type Range = '1' | '24' | '168';

interface TestResult {
  ok: boolean;
  model: string;
  durationMs?: number;
  totalTokens?: number;
  finishReason?: string;
  message?: string;
  content?: string;
}

export default function TrafficPage() {
  const { key } = useAuth();
  const toast = useToast();

  const [range, setRange] = useState<Range>('24');
  const [page, setPage] = useState(1);
  const [model, setModel] = useState('');
  const [failed, setFailed] = useState<TrafficResponse['data'][number] | null>(null);

  const [probeModel, setProbeModel] = useState('');
  const [probeMsg, setProbeMsg] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const traffic = useAsyncData(
    (signal) => getTraffic({ page, days: Number(range), model: model.trim() || undefined }, key, signal),
    [page, range, model, key],
    { enabled: !!key },
  );

  const sse = useAsyncData(
    (signal) => getSseDebug({ days: Number(range), limit: 50 }, key, signal),
    [range, key],
    { enabled: !!key },
  );

  const summary = traffic.data?.summary;
  const rows = traffic.data?.data ?? [];

  const metrics = [
    { key: '总请求', value: formatNumber(traffic.data?.total) },
    { key: '总 Token', value: formatNumber(summary?.tokens) },
    { key: '涉及模型', value: formatNumber(Object.keys(summary?.byModel ?? {}).length) },
    { key: '涉及账号', value: formatNumber(Object.keys(summary?.byAccount ?? {}).length) },
  ];

  async function sendTest() {
    if (!probeModel.trim()) {
      toast('请输入模型名', 'warn');
      return;
    }
    if (!probeMsg.trim()) {
      toast('请输入测试消息', 'warn');
      return;
    }
    setBusy(true);
    setTestResult(null);
    try {
      const r = await testChat(
        { model: probeModel.trim(), message: probeMsg.trim(), stream: false },
        key,
      );
      setTestResult({
        ok: r.ok,
        model: r.model,
        durationMs: r.durationMs,
        totalTokens: r.usage?.total_tokens,
        finishReason: r.finishReason,
        message: r.message,
        content: r.content,
      });
      toast(r.ok ? '测试请求完成' : `测试未成功：${r.message ?? '后端未给出原因'}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '测试请求失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title="请求日志"
      description="网关转发记录、SSE 调试与连通性测试"
      actions={
        <Segmented
          ariaLabel="时间范围"
          value={range}
          onChange={(v) => {
            setRange(v);
            setPage(1);
          }}
          options={[
            { value: '1', label: '近 1 小时' },
            { value: '24', label: '近 24 小时' },
            { value: '168', label: '近 7 日' },
          ]}
        />
      }
      toolbar={
        <>
          <div className="flex items-center gap-3">
            <div className="w-[240px]">
              <Field
                type="search"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setPage(1);
                }}
                placeholder="按模型筛选"
                aria-label="按模型筛选"
              />
            </div>
            <Button onClick={traffic.reload}>刷新</Button>
          </div>
          <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            第 {page} / {traffic.data?.totalPages ?? 1} 页
          </span>
        </>
      }
    >
      <Stack>
        {traffic.error && <ErrorState message={traffic.error} onRetry={traffic.reload} />}

        <MetricGrid items={metrics} />

        <Panel title="请求明细" flush>
          {traffic.loading && !traffic.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              区间内无请求记录
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th cell-num">#</th>
                  <th className="th">时间</th>
                  <th className="th">接口</th>
                  <th className="th">模型</th>
                  <th className="th">账号</th>
                  <th className="th">状态</th>
                  <th className="th cell-num">耗时</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">估算成本</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const bad = r.error || (typeof r.status === 'number' && r.status >= 400);
                  return (
                    <tr
                      key={r.seq ?? i}
                      className="row-hover cursor-pointer"
                      onClick={() => setFailed(bad ? r : null)}
                    >
                      <td className="td cell-num font-mono text-[11px]">{r.seq ?? '—'}</td>
                      <td className="td font-mono text-[12px]">{formatTime(r.ts)}</td>
                      <td className="td font-mono text-[11px] break-all">{r.endpoint || '—'}</td>
                      <td className="td font-mono text-[12px]">{r.model || '—'}</td>
                      <td className="td font-mono text-[12px]">{r.account || '—'}</td>
                      <td className="td">
                        <Chip tone={bad ? 'danger' : 'ok'} dot={bad ? 'dot-error' : 'dot-ok'}>
                          {r.status ?? (bad ? 'ERR' : 'OK')}
                        </Chip>
                      </td>
                      <td className="td cell-num">{r.durationMs == null ? '—' : formatDuration(r.durationMs)}</td>
                      <td className="td cell-num">{formatNumber(r.totalTokens)}</td>
                      <td className="td cell-num">{formatCost(r.estimatedCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="flex items-center justify-between">
          <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            共 {formatNumber(traffic.data?.total ?? 0)} 条记录
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              上一页
            </Button>
            <Button
              size="sm"
              disabled={page >= (traffic.data?.totalPages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>

        {failed && (
          <Panel title="失败详情" footer="错误信息来自网关转发链路的原始记录。">
            <div className="flex items-center gap-2 mb-2">
              <Chip tone="danger" dot="dot-error">
                {failed.status ?? 'ERR'}
              </Chip>
              <span className="font-mono text-[12px]">{failed.model || '—'}</span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                {formatTime(failed.ts)}
              </span>
            </div>
            <pre
              className="rounded-md border p-3 font-mono text-[12px] whitespace-pre-wrap break-all"
              style={{
                borderColor: 'var(--rg-border)',
                background: 'var(--rg-bg-secondary)',
                color: 'var(--rg-state-error)',
              }}
            >
              {failed.error || '未返回错误文本'}
            </pre>
          </Panel>
        )}

        <Panel
          title="SSE 调试记录"
          description="读取落盘的调试日志文件"
          footer="该接口读取落盘 JSONL 文件，不是实时推送；最新记录可能滞后于线上请求。"
          flush
        >
          {sse.error ? (
            <ErrorState message={sse.error} onRetry={sse.reload} />
          ) : sse.loading && !sse.data ? (
            <LoadingBlock />
          ) : (sse.data?.data ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无调试记录
            </div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 320 }}>
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">时间</th>
                    <th className="th">Request ID</th>
                    <th className="th">账号</th>
                    <th className="th">模型</th>
                    <th className="th">事件</th>
                  </tr>
                </thead>
                <tbody>
                  {(sse.data?.data ?? []).map((r, i) => (
                    <tr key={r.seq ?? i} className="row-hover">
                      <td className="td font-mono text-[12px]">{formatTime(r.ts)}</td>
                      <td className="td font-mono text-[11px] break-all">{r.requestId || '—'}</td>
                      <td className="td font-mono text-[12px]">{r.accountId || '—'}</td>
                      <td className="td font-mono text-[12px]">{r.model || '—'}</td>
                      <td className="td">
                        <Chip tone="brand">{r.event?.type || '—'}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="连通性测试" description="向上游发起一次真实请求">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="模型"
              value={probeModel}
              onChange={(e) => setProbeModel(e.target.value)}
              placeholder="例如 claude-sonnet-4"
              aria-label="测试用模型名"
            />
            <Field
              label="消息"
              value={probeMsg}
              onChange={(e) => setProbeMsg(e.target.value)}
              placeholder="输入测试内容"
              aria-label="测试消息内容"
            />
          </div>
          <div className="mt-3">
            <Button variant="primary" onClick={sendTest} disabled={busy}>
              {busy ? '发送中…' : '发送测试请求'}
            </Button>
          </div>

          {testResult && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <Chip tone={testResult.ok ? 'ok' : 'danger'} dot={testResult.ok ? 'dot-ok' : 'dot-error'}>
                  {testResult.ok ? '成功' : '失败'}
                </Chip>
                <span className="font-mono text-[12px]">{testResult.model}</span>
                {testResult.durationMs != null && (
                  <span className="text-[11px] font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {formatDuration(testResult.durationMs)}
                  </span>
                )}
                {testResult.totalTokens != null && (
                  <span className="text-[11px] font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {testResult.totalTokens} tokens
                  </span>
                )}
                {testResult.finishReason && (
                  <span className="text-[11px] font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {testResult.finishReason}
                  </span>
                )}
              </div>
              {testResult.content && (
                <pre
                  className="rounded-md border p-3 font-mono text-[12px] whitespace-pre-wrap break-all"
                  style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
                >
                  {testResult.content}
                </pre>
              )}
              {testResult.message && (
                <p className="text-[12px]" style={{ color: 'var(--rg-state-error)' }}>
                  {testResult.message}
                </p>
              )}
            </div>
          )}

          <div className="mt-3">
            <Note>该操作会真实消耗上游配额，仅在排查连通性问题时使用。</Note>
          </div>
        </Panel>
      </Stack>
    </PageShell>
  );
}