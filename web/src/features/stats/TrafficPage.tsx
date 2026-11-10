/**
 * 请求日志页：网关转发日志分页检索、SSE 调试记录与一键测试请求。
 *
 * 真实语义：
 *   - /v1/admin/traffic 后端已实现分页（page / totalPages / total），页面直接使用；
 *   - /v1/admin/debug/sse 接口名为 sse，实际读取写入文件的 JSONL 数据，不是实时推送，
 *     页面如实标注，避免运维误判。
 */
import { useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  getSseDebug,
  getTraffic,
  testChat,
  type TrafficResponse,
  type TrafficRow,
} from '../../shared/api/admin';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatDuration, formatNumber, formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
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

/**
 * 后端枚举 → 面向用户的说法。
 *
 * 这几张表此前把 `message_delta`、`stop`、`tool_calls` 原样渲染，
 * 与同页中文表头混排；映射表放在文件顶部，未知值回退原文而不是吞掉。
 */
const EVENT_LABEL: Record<string, string> = {
  message_start: '消息开始',
  message_delta: '文本增量',
  message_stop: '消息结束',
  content_block_start: '内容块开始',
  content_block_delta: '内容块增量',
  content_block_stop: '内容块结束',
  ping: '心跳',
  error: '错误',
};

const FINISH_LABEL: Record<string, string> = {
  stop: '正常结束',
  end_turn: '正常结束',
  length: '达到长度上限',
  max_tokens: '达到长度上限',
  tool_calls: '调用工具',
  tool_use: '调用工具',
  content_filter: '内容被过滤',
};

function eventLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return EVENT_LABEL[type] ?? type;
}

function finishReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '—';
  return FINISH_LABEL[reason] ?? reason;
}

interface TestResult {
  ok: boolean;
  model: string;
  durationMs?: number;
  totalTokens?: number;
  finishReason?: string;
  message?: string;
  content?: string;
}

/**
 * 该行实际命中的上游模型名。
 *
 * 必须优先取 pricedModel（日志侧按真实命中的候选写入）：虚拟模型行的 model 是
 * 对外 ID（如 vm/unified-chat），上游模型名只存在于 pricedModel / routedTo。
 * 历史行没有 pricedModel 时退回解析 routedTo（形如 "trae/qwen3.8-flash@max"，
 * 取最后一段），最后才用 model。与后端 log/stats.js#pricedModelOf 同口径。
 */
function upstreamModelOf(r: TrafficRow): string {
  if (r.pricedModel) return r.pricedModel;
  const rt = r.routedTo || '';
  if (rt) {
    const seg = rt.split('/').filter(Boolean).pop();
    if (seg) return seg;
  }
  return r.model || '';
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
  // 序号列按**当前展示顺序**连续编号（跨页接续），不直接用日志里的 seq。
  // seq 是进程内自增计数器：网关重启会从 1 重新开始，同一天内因此出现多段
  // 互不衔接的编号（实测某日 48 次回退），而表格是按时间新→旧排序的，
  // 直接显示 seq 就会呈现「时间有序、序号乱序」。它只用于排查，不代表排序。
  //
  // 偏移取**后端实际生效**的页码与页长，而不是本地状态：后端会把越界的 page
  // 钳到 totalPages，数据随时间窗收缩时本地 page 可能已越界，用本地值会让
  // 编号与「第 N 页」的显示一起错位。
  const effPage = traffic.data?.page ?? page;
  const pageSize = traffic.data?.pageSize ?? 50;
  const rowNo = (i: number) => (effPage - 1) * pageSize + i + 1;

  const metrics = [
    { key: '总请求', value: formatNumber(traffic.data?.total) },
    {
      key: '总 Token',
      // 历史日志的 Token 被误脱敏成 "***" 无法还原，此时总量是下界；
      // 显式带出受损行数，避免被读成「消耗确实这么少」
      value:
        (summary?.tokensMasked ?? 0) > 0
          ? `${formatNumber(summary?.tokens)} *`
          : formatNumber(summary?.tokens),
      delta: (summary?.tokensMasked ?? 0) > 0
        ? `另有 ${formatNumber(summary?.tokensMasked)} 行 Token 已丢失`
        : undefined,
    },
    { key: '涉及模型', value: formatNumber(Object.keys(summary?.byModel ?? {}).length) },
    { key: '涉及账号', value: formatNumber(Object.keys(summary?.byAccount ?? {}).length) },
  ];

  async function sendTest() {
    if (!probeModel.trim()) {
      toast('未填写模型名，无法发送测试请求', 'warn');
      return;
    }
    if (!probeMsg.trim()) {
      toast('未填写测试消息，无法发送测试请求', 'warn');
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
      toast(r.ok ? '测试请求完成' : `测试未成功：${r.message ?? '网关未返回失败原因；若持续出现，请到「运维 → 定时任务」查看任务日志'}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '测试请求发送失败，可重试', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title="请求日志"
      description="查看网关转发记录、定位失败请求与测试连通性"
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
          <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
            第 {effPage} 页 · 共 {traffic.data?.totalPages ?? 1} 页
          </span>
        </>
      }
    >
      <Stack>
        {traffic.error && <ErrorState message={traffic.error} onRetry={traffic.reload} />}

        <MetricGrid items={metrics} />

        {(summary?.tokensMasked ?? 0) > 0 && (
          <Note>
            「总 Token」后的星号表示有行的 Token 在历史日志里被脱敏丢失、无法还原，
            该总量是下界而非真实消耗。
          </Note>
        )}

        <Panel title="请求明细" flush>
          {traffic.loading && !traffic.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            model.trim() ? (
              <EmptyState
                label={`没有匹配模型「${model.trim()}」的转发记录。`}
                hint="模型名需与请求日志中的名称完全一致（如 trae/glm-5）。"
                action={{ label: '清除筛选', onClick: () => { setModel(''); setPage(1); } }}
              />
            ) : (
              <EmptyState
                label="所选区间内没有转发请求记录"
                hint="把时间范围切到「近 24 小时」或「近 7 日」再看；客户端发起请求后即会出现。"
              />
            )
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th cell-num">#</th>
                  <th className="th">时间</th>
                  <th className="th">接口</th>
                  <th className="th">模型</th>
                  <th className="th">上游模型</th>
                  <th className="th">账号</th>
                  <th className="th">状态</th>
                  <th className="th cell-num">耗时</th>
                  <th className="th cell-num">Token</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const bad = r.error || (typeof r.status === 'number' && r.status >= 400);
                  return (
                    <tr
                      // seq 是进程内计数器，网关重启会重复（同一天内可多次回到 1），
                      // 单用它当 key 会撞键。拼上时间与下标保证唯一。
                      key={`${r.ts ?? ''}-${r.seq ?? ''}-${i}`}
                      className={bad ? 'row-hover cursor-pointer' : 'row-hover'}
                      // 整行可点必须同时可聚焦：只挂 onClick 时键盘与读屏用户
                      // 无法打开失败详情（Tab 到不了、回车不触发）。
                      tabIndex={bad ? 0 : undefined}
                      role={bad ? 'button' : undefined}
                      aria-label={bad ? `查看第 ${rowNo(i)} 行的失败详情` : undefined}
                      onClick={bad ? () => setFailed(r) : undefined}
                      onKeyDown={
                        bad
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setFailed(r);
                              }
                            }
                          : undefined
                      }
                      title={bad ? '点击查看失败详情' : undefined}
                    >
                      <td className="td cell-num font-mono text-aux">{rowNo(i)}</td>
                      <td className="td td-mono">{formatTime(r.ts)}</td>
                      <td className="td font-mono text-aux break-all">{r.endpoint || '—'}</td>
                      <td className="td td-mono">{r.model || '—'}</td>
                      <td className="td td-mono break-all">{upstreamModelOf(r) || '—'}</td>
                      <td className="td td-mono">{r.account || '—'}</td>
                      <td className="td">
                        <Chip tone={bad ? 'danger' : 'ok'} dot={bad ? 'dot-error' : 'dot-ok'}>
                          {typeof r.status === 'number' ? `HTTP ${r.status}` : bad ? '失败' : '成功'}
                        </Chip>
                      </td>
                      <td className="td cell-num">{r.durationMs == null ? '—' : formatDuration(r.durationMs)}</td>
                      <td className="td cell-num">{formatNumber(r.totalTokens)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="flex items-center justify-between">
          <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
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
          <Panel title="失败详情" footer="错误信息来自网关转发记录的原文。">
            <div className="flex items-center gap-2 mb-2">
              <Chip tone="danger" dot="dot-error">
                {failed.status ?? 'ERR'}
              </Chip>
              <span className="font-mono text-aux">{failed.model || '—'}</span>
              <span className="font-mono text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                {formatTime(failed.ts)}
              </span>
            </div>
            <pre className="code-block" style={{ color: 'var(--rg-state-error)' }}>
              {failed.error || '网关未返回错误文本'}
            </pre>
          </Panel>
        )}

        <Panel
          title="SSE 调试记录"
          description="读取已写入文件的调试日志"
          footer="该接口读取已写入文件的 JSONL 记录，不是实时推送；最新记录可能滞后于线上请求。"
          flush
        >
          {sse.error ? (
            <ErrorState message={sse.error} onRetry={sse.reload} />
          ) : sse.loading && !sse.data ? (
            <LoadingBlock />
          ) : (sse.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="所选区间内没有 SSE 调试记录"
              hint="这类记录只在排查上游事件流问题时产生（TRAE_DEBUG_SSE 开启），平时为空是正常的。"
            />
          ) : (
            <div className="scroll-y overflow-x-auto" style={{ maxHeight: 320 }}>
              <table className="data-table">
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
                      <td className="td td-mono">{formatTime(r.ts)}</td>
                      <td className="td font-mono text-aux break-all">{r.requestId || '—'}</td>
                      <td className="td td-mono">{r.accountId || '—'}</td>
                      <td className="td td-mono">{r.model || '—'}</td>
                      <td className="td">
                        <Chip tone="brand">{eventLabel(r.event?.type)}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="连通性测试" description="向上游发起一次真实请求，验证访问密钥与模型可用">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="模型"
              value={probeModel}
              onChange={(e) => setProbeModel(e.target.value)}
              placeholder="例如 claude-sonnet-4"
            />
            <Field
              label="测试消息"
              value={probeMsg}
              onChange={(e) => setProbeMsg(e.target.value)}
              placeholder="输入测试内容"
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
                <span className="font-mono text-aux">{testResult.model}</span>
                {testResult.durationMs != null && (
                  <span className="text-aux font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {formatDuration(testResult.durationMs)}
                  </span>
                )}
                {testResult.totalTokens != null && (
                  <span className="text-aux font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {testResult.totalTokens} Token
                  </span>
                )}
                {testResult.finishReason && (
                  <span className="text-aux font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {finishReasonLabel(testResult.finishReason)}
                  </span>
                )}
              </div>
              {testResult.content && (
                <pre
                  className="code-block"
                >
                  {testResult.content}
                </pre>
              )}
              {testResult.message && (
                <p className="text-aux" style={{ color: 'var(--rg-state-error)' }}>
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