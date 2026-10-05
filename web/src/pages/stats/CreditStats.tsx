import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard';
import { Panel, Note, ICON } from '../../components/ui';
import { BarChart } from '../../components/charts';
import { useAuth } from '../../stores/useAuth';
import {
  getCreditHistory,
  getStatsDaily,
  getOfficialUsage,
  type CreditRow,
  type DailyStat,
  type OfficialUsageResponse,
} from '../../api/admin';
import { fmtBalance, fmtInt } from '../../lib/format';
import SourceSwitch, { type SourceOption } from './SourceSwitch';

const DAY_OPTIONS = [7, 14, 30] as const;

const SOURCES: SourceOption[] = [
  { id: 'snapshot', label: '网关转发（快照差分）', hint: '相邻余额快照下降量推算，下界非精确，含 WorkBuddy / Trae' },
  { id: 'official', label: '客户端消耗（官方账单）', hint: '逐请求 credit 精确值，仅 WorkBuddy 账号有此接口' },
];

/**
 * 积分消耗。两条独立口径并列，不混算：
 *
 *   快照差分 —— 余额快照相邻下降量推算；余额上涨（签到、奖励）不计，故是下界。
 *              覆盖全部账号，但精度受快照密度影响（自动刷新关闭时失真明显）。
 *   官方账单 —— WorkBuddy 官方逐请求 credit，精确值；Trae 无此接口，界面如实标注。
 *
 * 两者数值不必相等：模型计费口径、按计费模型归并方式不同，更关键的是快照差分
 * 只能给「下界」。两个数字互相印证，但谁也不应是另一个的校验基准。
 */
export default function CreditStats() {
  const { key } = useAuth();
  const [days, setDays] = useState<number>(14);
  const [source, setSource] = useState<string>('snapshot');
  const [rows, setRows] = useState<CreditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [official, setOfficial] = useState<OfficialUsageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [officialErr, setOfficialErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * 两个数据源各自独立取数：一侧失败不影响另一侧。
   * 服务端未部署新端点时，官方账单侧报错而快照差分侧仍可用。
   */
  const load = useCallback(
    (d: number) => {
      if (!key) return;
      setLoading(true);
      Promise.allSettled([
        getCreditHistory(d, key),
        getStatsDaily(d, key),
        getOfficialUsage(d, key),
      ])
        .then(([c, dd, off]) => {
          if (c.status === 'fulfilled') {
            setRows(c.value.data || []);
            setTotal(c.value.totalUsed || 0);
          }
          if (dd.status === 'fulfilled') setDaily(dd.value.data || []);
          const gwErr = c.status === 'rejected' ? c.reason?.message : dd.status === 'rejected' ? dd.reason?.message : null;
          setErr(gwErr || null);
          if (off.status === 'fulfilled') {
            setOfficial(off.value);
            setOfficialErr(null);
          } else {
            setOfficial(null);
            setOfficialErr(off.reason?.message || '官方账单接口不可用');
          }
        })
        .finally(() => setLoading(false));
    },
    [key],
  );

  useEffect(() => {
    load(days);
  }, [key, days, load]);

  const sorted = [...rows].sort((a, b) => (Number(b.todayUsed) || 0) - (Number(a.todayUsed) || 0));
  const maxUsed = sorted.reduce((s, r) => Math.max(s, Number(r.todayUsed) || 0), 0);
  const activeN = rows.filter((r) => (Number(r.todayUsed) || 0) > 0).length;

  const costSeries = [...daily].reverse().map((d) => ({ label: d.date, value: d.estimatedCost }));
  const costSum = daily.reduce((s, d) => s + d.estimatedCost, 0);

  // 官方账单聚合
  const offAccounts = official?.accounts || [];
  const offAvailable = offAccounts.filter((a) => a.available);
  const offTotal = offAvailable.reduce((s, a) => s + a.credit, 0);
  const offModelMap = new Map<string, { credit: number; requests: number }>();
  for (const a of offAvailable) {
    for (const m of a.byModel) {
      const t = offModelMap.get(m.model) || { credit: 0, requests: 0 };
      t.credit += m.credit;
      t.requests += m.requests;
      offModelMap.set(m.model, t);
    }
  }
  const offModels = [...offModelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.credit - a.credit);
  const offMaxModel = offModels.reduce((s, m) => Math.max(s, m.credit), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg-track" role="group" aria-label="统计区间">
          {DAY_OPTIONS.map((d) => (
            <button key={d} type="button" className="seg-tab" aria-pressed={days === d} onClick={() => setDays(d)}>
              近 {d} 日
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(days)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      <SourceSwitch options={SOURCES} value={source} onChange={setSource} />

      {err && <div className="text-sm text-danger">{err}</div>}

      {source === 'snapshot' && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <StatCard label="快照差分消耗" value={fmtBalance(total)} hint={`近 ${days} 日，余额下降部分`} accent="acc" />
            <StatCard label="有消耗账号" value={activeN} hint={`共 ${rows.length} 个账号在册`} />
            <StatCard label="单账号最高" value={fmtBalance(maxUsed)} hint="该窗口内消耗最大的账号" />
            <StatCard
              label="日志侧估算"
              value={fmtBalance(costSum)}
              hint="按请求日志逐条估算，与快照差分为两种独立口径"
            />
          </div>

          <Note kind="info" icon={ICON.info}>
            <b>本页为估算口径，不是精确计量。</b>
            <br />
            余额由相邻两次快照做差分推算，上涨部分（签到、活动奖励）不计入消耗，因此实际消耗通常不低于此数。
            若账号自动刷新处于关闭状态，快照过稀会使本侧明显失真——此时请切到「官方账单」对照。
          </Note>

          <Panel
            title="日志侧估算积分趋势"
            desc="按请求日志的逐条估算累加，与上方的快照差分互相印证。两者口径不同，数值不必相等。"
            bodyClass="px-5 py-4"
          >
            <BarChart series={costSeries} aria="每日估算积分消耗" color="var(--warn)" />
            <div className="legend">
              <span>
                <i style={{ background: 'var(--warn)' }} />
                当日估算积分
              </span>
            </div>
          </Panel>

          <Panel title="账号消耗排行" desc={`近 ${days} 日按快照差分统计，条形长度按本表最大值归一。`}>
            {!sorted.length ? (
              <div className="text-center py-10 text-ink-soft text-[13px]">
                暂无数据，需至少两次余额刷新才能形成差分
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px] min-w-[560px]">
                  <thead>
                    <tr>
                      <th className="th">账号</th>
                      <th className="th cell-num">消耗</th>
                      <th className="th cell-num" style={{ width: '42%' }}>
                        占比
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => {
                      const v = Number(r.todayUsed) || 0;
                      const pct = maxUsed ? (v / maxUsed) * 100 : 0;
                      return (
                        <tr key={`${r.label || 'row'}#${i}`} className="row-hover">
                          <td className="td font-medium text-ink">{r.label || '—'}</td>
                          <td className="td cell-num tabular-nums">{fmtBalance(v)}</td>
                          <td className="td cell-num">
                            <span className="inline-flex items-center justify-end gap-2">
                              <span className="bar" style={{ maxWidth: 160, width: '100%' }}>
                                <i style={{ width: `${pct}%` }} />
                              </span>
                              <span className="text-[11.5px] text-ink-faint tabular-nums shrink-0 w-11 text-right">
                                {total ? ((v / total) * 100).toFixed(1) : '0.0'}%
                              </span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {sorted.length > 0 && (
              <div className="px-5 py-2.5 border-t border-line-hairline text-[11.5px] text-ink-faint">
                合计 {fmtBalance(total)} · 覆盖 {rows.length} 个账号 · {fmtInt(activeN)} 个有消耗
              </div>
            )}
          </Panel>
        </>
      )}

      {source === 'official' && (
        <>
          {officialErr ? (
            <Note kind="warn" icon={ICON.alert}>
              <b>官方账单数据暂不可用。</b>
              <br />
              该视图依赖后端端点 /v1/admin/stats/official-usage。若后端尚未更新到含该端点的版本，
              请求会被路由到转发面鉴权而返回 401，属预期现象而非账号问题。
              <br />
              <span className="text-ink-faint">原始响应：{officialErr}</span>
            </Note>
          ) : offAvailable.length === 0 ? (
            <Note kind="warn" icon={ICON.alert}>
              <b>本机无可用的 WorkBuddy 账号或账单接口暂不可达。</b>
              <br />
              该侧依赖 WorkBuddy 官方账单接口（get-user-request-usage），Trae 账号无此接口故不参与。
              若账号存在但仍为空，多为接口鉴权或配额问题，可稍后重试。
            </Note>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
                <StatCard
                  label="精确积分消耗"
                  value={fmtBalance(offTotal)}
                  hint={`近 ${days} 日，逐请求 credit 累加`}
                  accent="acc"
                />
                <StatCard
                  label="覆盖账号"
                  value={`${offAvailable.length}/${offAccounts.length}`}
                  hint="仅 WorkBuddy 账号有此接口，Trae 不参与"
                />
                <StatCard
                  label="请求总数"
                  value={fmtInt(offAvailable.reduce((s, a) => s + a.requests, 0))}
                  hint="官方账单逐请求计数"
                />
              </div>

              <Note kind="info" icon={ICON.info}>
                <b>这是精确消耗值，不是估算。</b>
                <br />
                数据来自 WorkBuddy 官方逐请求账单，credit 字段为实际扣减。与左侧「快照差分」是两套独立口径，
                二者数值接近但不相等属正常现象——模型计费归并方式不同，且快照差分只能给下界。
                Trae 账号无此接口，未计入本视图。
              </Note>

              <Panel
                title="各 WorkBuddy 账号消耗"
                desc="按官方账单逐请求 credit 累加，按账号拆分。"
                bodyClass="px-5 py-4"
              >
                <table className="w-full border-collapse text-[12.5px] min-w-[420px]">
                  <thead>
                    <tr>
                      <th className="th">账号</th>
                      <th className="th cell-num">请求</th>
                      <th className="th cell-num">精确消耗</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offAvailable.map((a) => (
                      <tr key={a.accountId} className="row-hover">
                        <td className="td font-medium text-ink">
                          {a.label}
                          {a.error && <span className="ml-2 text-[11px] text-warn">（部分日取数失败）</span>}
                        </td>
                        <td className="td cell-num">{fmtInt(a.requests)}</td>
                        <td className="td cell-num tabular-nums">{fmtBalance(a.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-5 py-2.5 border-t border-line-hairline text-[11.5px] text-ink-faint">
                  合计精确消耗 {fmtBalance(offTotal)} · 单日最多扫描 30 天，结果本地缓存
                </div>
              </Panel>

              <Panel title="按模型精确消耗" desc="模型计费口径与客户端口径不同，与「客户端消耗」侧的模型明细不必对应。">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px] min-w-[480px]">
                    <thead>
                      <tr>
                        <th className="th">模型</th>
                        <th className="th cell-num">请求</th>
                        <th className="th cell-num">精确消耗</th>
                        <th className="th cell-num">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {offModels.map((m) => {
                        const pct = offMaxModel ? (m.credit / offMaxModel) * 100 : 0;
                        return (
                          <tr key={m.model} className="row-hover">
                            <td className="td font-medium text-ink">{m.model}</td>
                            <td className="td cell-num">{fmtInt(m.requests)}</td>
                            <td className="td cell-num tabular-nums">{fmtBalance(m.credit)}</td>
                            <td className="td cell-num">
                              <span className="inline-flex items-center justify-end gap-2">
                                <span className="bar" style={{ maxWidth: 160, width: '100%' }}>
                                  <i style={{ width: `${pct}%`, background: 'var(--acc)' }} />
                                </span>
                                <span className="text-[11.5px] text-ink-faint tabular-nums shrink-0 w-11 text-right">
                                  {offTotal ? ((m.credit / offTotal) * 100).toFixed(1) : '0.0'}%
                                </span>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {!offModels.length && (
                        <tr>
                          <td colSpan={4} className="text-center py-10 text-ink-soft text-[13px]">
                            近 {days} 日无计费记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}
