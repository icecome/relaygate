/**
 * 用量与成本页。
 *
 * 两套口径分开呈现，不混算：
 * - Token：上游真实 usage（优先）+ tiktoken 补算（usage 缺失时）。
 *   metered / unmetered 仍是真实字段，用于说明有多少请求拿到了上游真值。
 * - 积分：WorkBuddy 官方账单的逐请求 credit 为主口径（精确值）；
 *   Trae 侧无对等接口，只能用本地费率表估算，故两者分行展示。
 */
import { useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  clearClientStatsCache,
  getClientStats,
  getCreditHistory,
  getOfficialUsage,
  getStatsAccounts,
  getStatsDaily,
  getStatsModels,
} from '../../shared/api/stats';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatCost, formatNumber } from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  KeyValue,
  LoadingBlock,
  MetricGrid,
  Note,
  Panel,
  ProgressBar,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { DailyTrendChart } from './DailyTrendChart';

type Range = '1' | '7' | '30';

export default function TokenStatsPage() {
  const { key } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState<Range>('7');
  const days = Number(range);

  const daily = useAsyncData((signal) => getStatsDaily(days, key, signal), [days, key], { enabled: !!key });
  const models = useAsyncData((signal) => getStatsModels(days, key, signal), [days, key], { enabled: !!key });
  const accounts = useAsyncData((signal) => getStatsAccounts(days, key, signal), [days, key], { enabled: !!key });
  const client = useAsyncData((signal) => getClientStats(days, key, signal), [days, key], { enabled: !!key });
  const official = useAsyncData((signal) => getOfficialUsage(days, key, signal), [days, key], { enabled: !!key });
  const credit = useAsyncData((signal) => getCreditHistory(days, key, signal), [days, key], { enabled: !!key });

  const totals = useMemo(() => {
    const rows = daily.data?.data ?? [];
    const sum = rows.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        errors: acc.errors + r.errors,
        tokens: acc.tokens + r.tokens,
        metered: acc.metered + r.metered,
        unmetered: acc.unmetered + r.unmetered,
        cost: acc.cost + r.estimatedCost,
      }),
      { requests: 0, errors: 0, tokens: 0, metered: 0, unmetered: 0, cost: 0 },
    );
    return sum;
  }, [daily.data]);

  // 积分主口径：上游官方账单。Trae 逐会话、WorkBuddy 逐请求，都是精确值。
  const officialTotals = useMemo(() => {
    const list = official.data?.accounts ?? [];
    const ok = list.filter((a) => a.available);
    const sum = (pred: (a: (typeof ok)[number]) => boolean) => {
      const hit = ok.filter(pred);
      return {
        credit: hit.reduce((s, a) => s + a.credit, 0),
        requests: hit.reduce((s, a) => s + a.requests, 0),
        tokens: hit.reduce((s, a) => s + (a.tokens ?? 0), 0),
        accounts: hit.length,
      };
    };
    const trae = sum((a) => a.platform === 'trae');
    const wb = sum((a) => a.platform === 'workbuddy');
    return {
      trae,
      wb,
      credit: trae.credit + wb.credit,
      accounts: ok.length,
      total: list.length,
    };
  }, [official.data]);

  const metrics = [
    { key: '总请求', value: formatNumber(totals.requests), delta: `错误 ${formatNumber(totals.errors)}` },
    { key: '总 Token', value: formatNumber(totals.tokens), delta: '真实 usage + 补算' },
    {
      key: '官方账单积分',
      value: formatNumber(officialTotals.credit),
      delta:
        officialTotals.accounts > 0
          ? `Trae ${officialTotals.trae.accounts} 账号 · WB ${officialTotals.wb.accounts} 账号`
          : '无可用账号',
    },
    { key: '本地估算成本', value: formatCost(totals.cost), delta: '费率表推算，仅作对照' },
  ];

  async function clearCache() {
    try {
      await clearClientStatsCache(key);
      toast('客户端统计缓存已清理', 'ok');
      client.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '清理失败', 'err');
    }
  }

  return (
    <PageShell
      title="用量与成本"
      description="网关转发与本机客户端的用量对比"
      actions={
        <>
          <Segmented
            ariaLabel="时间范围"
            value={range}
            onChange={setRange}
            options={[
              { value: '1', label: '今日' },
              { value: '7', label: '近 7 日' },
              { value: '30', label: '近 30 日' },
            ]}
          />
          <Button onClick={clearCache}>清理客户端缓存</Button>
        </>
      }
    >
      <Stack>
        {daily.error && <ErrorState message={daily.error} onRetry={daily.reload} />}

        <MetricGrid items={metrics} />

        <Panel
          title="每日趋势"
          description="请求量、错误数与 Token 走势"
          footer="Token = 上游真实 usage（优先）+ tiktoken 补算（usage 缺失时）；补算值与上游分词器存在偏差，仅供趋势参考。"
        >
          {daily.loading && !daily.data ? (
            <LoadingBlock />
          ) : (daily.data?.data ?? []).length === 0 ? (
            <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              区间内无数据
            </div>
          ) : (
            <DailyTrendChart rows={daily.data?.data ?? []} />
          )}
        </Panel>

        <Panel title="模型维度" description="按模型聚合的请求与成本" flush>
          {models.loading && !models.data ? (
            <LoadingBlock />
          ) : (models.data?.data ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无模型数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">模型</th>
                  <th className="th cell-num">请求</th>
                  <th className="th cell-num">错误</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">已计量</th>
                  <th className="th cell-num">未计量</th>
                  <th className="th cell-num">平均延迟</th>
                  <th className="th cell-num">估算成本</th>
                </tr>
              </thead>
              <tbody>
                {(models.data?.data ?? []).map((m) => (
                  <tr key={m.model} className="row-hover">
                    <td className="td font-mono text-[12px]">{m.model}</td>
                    <td className="td cell-num">{formatNumber(m.requests)}</td>
                    <td className="td cell-num">{formatNumber(m.errors)}</td>
                    <td className="td cell-num">{formatNumber(m.tokens)}</td>
                    <td className="td cell-num">{formatNumber(m.metered)}</td>
                    <td className="td cell-num">
                      {m.unmetered > 0 ? (
                        <span style={{ color: 'var(--rg-state-warning)' }}>{formatNumber(m.unmetered)}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="td cell-num">
                      {m.avgDurationMs == null ? '—' : `${Math.round(m.avgDurationMs)}ms`}
                    </td>
                    <td className="td cell-num">{formatCost(m.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="账号维度" description="按账号聚合的请求与成本" flush>
          {accounts.loading && !accounts.data ? (
            <LoadingBlock />
          ) : (accounts.data?.data ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无账号数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th cell-num">请求</th>
                  <th className="th cell-num">错误率</th>
                  <th className="th cell-num">Token 占比</th>
                  <th className="th cell-num">估算成本</th>
                </tr>
              </thead>
              <tbody>
                {(accounts.data?.data ?? []).map((a) => (
                  <tr key={a.accountId} className="row-hover">
                    <td className="td font-mono text-[12px]">{a.accountId}</td>
                    <td className="td cell-num">{formatNumber(a.requests)}</td>
                    <td className="td">
                      <div className="min-w-[110px]">
                        <ProgressBar
                          ratio={a.errorRate / 100}
                          tone={a.errorRate > 5 ? 'danger' : a.errorRate > 0 ? 'warn' : 'brand'}
                        />
                        <div className="text-[11px] mt-1 font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                          {a.errorRate.toFixed(2)}%
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      <div className="min-w-[110px]">
                        <ProgressBar ratio={a.tokenShare / 100} tone="soft" />
                        <div className="text-[11px] mt-1 font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                          {a.tokenShare.toFixed(1)}%
                        </div>
                      </div>
                    </td>
                    <td className="td cell-num">{formatCost(a.estimatedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="本机客户端"
          description="扫描本机 WorkBuddy 会话日志，与网关转发并列但来源不同"
        >
          {client.error ? (
            <ErrorState message={client.error} onRetry={client.reload} />
          ) : client.loading && !client.data ? (
            <LoadingBlock />
          ) : !client.data?.available ? (
            <Note>
              本机统计不可用：{client.data?.reason || '未返回原因'}。该数据依赖本机会话日志文件，网关转发数据不受影响。
            </Note>
          ) : (
            <KeyValue
              rows={[
                { k: '可用状态', v: <Chip tone="ok" dot="dot-ok">可用</Chip> },
                { k: '扫描文件', v: <span className="font-mono">{formatNumber(client.data.files)}</span> },
                { k: '已解析', v: <span className="font-mono">{formatNumber(client.data.parsedFiles)}</span> },
                { k: '请求数', v: <span className="font-mono">{formatNumber(client.data.totals.requests)}</span> },
                { k: 'Token', v: <span className="font-mono">{formatNumber(client.data.totals.tokens)}</span> },
                {
                  k: '缓存命中',
                  v: <span className="font-mono">{(client.data.totals.cacheHitRate * 100).toFixed(1)}%</span>,
                },
                { k: 'Credit', v: <span className="font-mono">{formatNumber(client.data.totals.credit)}</span> },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="官方账单"
          description="上游精确积分（主口径）：Trae 逐会话、WorkBuddy 逐请求"
          flush
          footer="粒度不同：Trae 一行 = 一次完整会话的聚合（含 token 明细）；WorkBuddy 一行 = 单次模型调用。上游按会话落库有滞后，近一两天数据可能尚未入账。"
        >
          {official.loading && !official.data ? (
            <LoadingBlock />
          ) : (official.data?.accounts ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无账单数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th">平台</th>
                  <th className="th">可用</th>
                  <th className="th cell-num">明细行</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">Credit</th>
                  <th className="th">最近错误</th>
                </tr>
              </thead>
              <tbody>
                {(official.data?.accounts ?? []).map((a) => (
                  <tr key={`${a.platform ?? ''}-${a.accountId}`} className="row-hover">
                    <td className="td">{a.label || a.accountId}</td>
                    <td className="td">
                      <Chip tone={a.platform === 'trae' ? 'brand' : 'neutral'}>
                        {a.platform === 'trae' ? 'Trae' : 'WorkBuddy'}
                      </Chip>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {a.granularity === 'session' ? '逐会话' : '逐请求'}
                      </div>
                    </td>
                    <td className="td">
                      <Chip tone={a.available ? 'ok' : 'danger'} dot={a.available ? 'dot-ok' : 'dot-error'}>
                        {a.available ? '可用' : '不可用'}
                      </Chip>
                    </td>
                    <td className="td cell-num">{a.available ? formatNumber(a.requests) : '—'}</td>
                    <td className="td cell-num">
                      {a.available && a.tokens != null ? formatNumber(a.tokens) : '—'}
                    </td>
                    <td className="td cell-num">{a.available ? formatNumber(a.credit) : '—'}</td>
                    <td className="td font-mono text-[11px] break-all">{a.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {(official.data?.accounts ?? []).some((a) => (a.byModel ?? []).length > 0) && (
          <Panel
            title="账单模型拆分"
            description="官方账单里各模型消耗的积分（Trae 逐会话按模型拆分；WB 按请求聚合）"
            flush
          >
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th">模型</th>
                  <th className="th cell-num">明细行</th>
                  <th className="th cell-num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {(official.data?.accounts ?? []).flatMap((a) =>
                  (a.byModel ?? []).map((m) => (
                    <tr key={`${a.accountId}-${m.model}`} className="row-hover">
                      <td className="td">{a.label || a.accountId}</td>
                      <td className="td font-mono text-[12px]">{m.model}</td>
                      <td className="td cell-num">{formatNumber(m.requests)}</td>
                      <td className="td cell-num">{formatNumber(m.credits)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </Panel>
        )}

        <Panel title="积分消耗" flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th cell-num">今日消耗</th>
              </tr>
            </thead>
            <tbody>
              {(credit.data?.data ?? []).map((c, i) => (
                <tr key={`${c.label ?? i}`} className="row-hover">
                  <td className="td">{c.label || '—'}</td>
                  <td className="td cell-num">{formatNumber(c.todayUsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Note>
          积分主口径为上游官方账单：Trae 逐会话（query_user_usage_group_by_session）、
          WorkBuddy 逐请求（get-user-request-usage），均为上游精确值。
          本地估算成本由费率表推算，仅作 Trae 老数据与无账单场景的对照，不建议与官方值相加。
        </Note>
      </Stack>
    </PageShell>
  );
}