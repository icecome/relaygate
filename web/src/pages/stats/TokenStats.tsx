import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard';
import { Panel, Note, ICON } from '../../components/ui';
import { BarChart, CoverageChart, CoverageBar } from '../../components/charts';
import { useAuth } from '../../stores/useAuth';
import {
  getStatsDaily,
  getStatsModels,
  getClientStats,
  type DailyStat,
  type ModelStat,
  type ClientStatsResponse,
} from '../../api/admin';
import { fmtTokens, fmtInt } from '../../lib/format';
import SourceSwitch, { type SourceOption } from './SourceSwitch';

const DAY_OPTIONS = [7, 14, 30] as const;

const SOURCES: SourceOption[] = [
  { id: 'gateway', label: '网关转发', hint: '读 logs/<日期>/traffic.jsonl，只含经 RelayGate 的请求' },
  { id: 'client', label: '客户端消耗', hint: '读本机 WorkBuddy 会话日志，含该客户端全部调用' },
];

/**
 * Token 用量。两个数据源并列，各自独立可信，不混算：
 *
 *   网关转发 —— 上游响应带 usage 才算计量。WorkBuddy 平台不上报 usage，
 *              因此该侧覆盖率天然偏低，需用 metered / unmetered 明确区分。
 *   客户端消耗 —— 客户端自己记录的 usage，接近全量；但日志无账号标识，
 *              只能给本机全局汇总，不做账号归因。
 *
 * 两侧条数不必相等：一次客户端调用若被网关重试或切换账号，网关侧会多于客户端侧。
 */
export default function TokenStats() {
  const { key } = useAuth();
  const [days, setDays] = useState<number>(14);
  const [source, setSource] = useState<string>('gateway');
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [models, setModels] = useState<ModelStat[]>([]);
  const [client, setClient] = useState<ClientStatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clientErr, setClientErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * 两个数据源各自独立取数：一侧失败不影响另一侧。
   * 服务端未部署新端点时，客户端侧报错而网关侧仍可用。
   */
  const load = useCallback(
    (d: number) => {
      if (!key) return;
      setLoading(true);
      Promise.allSettled([getStatsDaily(d, key), getStatsModels(d, key), getClientStats(d, key)])
        .then(([dd, mm, cc]) => {
          if (dd.status === 'fulfilled') setDaily(dd.value.data || []);
          if (mm.status === 'fulfilled') setModels(mm.value.data || []);
          const gwErr = dd.status === 'rejected' ? dd.reason?.message : mm.status === 'rejected' ? mm.reason?.message : null;
          setErr(gwErr || null);
          if (cc.status === 'fulfilled') {
            setClient(cc.value);
            setClientErr(null);
          } else {
            setClient(null);
            setClientErr(cc.reason?.message || '客户端统计接口不可用');
          }
        })
        .finally(() => setLoading(false));
    },
    [key],
  );

  useEffect(() => {
    load(days);
  }, [key, days, load]);

  const req = daily.reduce((s, d) => s + d.requests, 0);
  const errN = daily.reduce((s, d) => s + d.errors, 0);
  const tok = daily.reduce((s, d) => s + d.tokens, 0);
  const met = daily.reduce((s, d) => s + (d.metered ?? 0), 0);
  const cov = req ? (met / req) * 100 : 0;
  const avgPerReq = met ? tok / met : 0;

  const meteredModels = models.filter((m) => (m.metered ?? 0) > 0).sort((a, b) => b.tokens - a.tokens);
  const unmeteredModels = models.filter((m) => (m.metered ?? 0) === 0).sort((a, b) => b.requests - a.requests);
  const unmeteredReq = unmeteredModels.reduce((s, m) => s + m.requests, 0);

  /** 平台标签：虚拟模型走 who-model，其余按来源推断 */
  const platOf = (model: string): { who: string; label: string } => {
    if (model.startsWith('vm/')) return { who: 'who-model', label: '虚拟模型' };
    if (/deepseek|glm|claude|gpt|qwen/i.test(model) && !/Official/i.test(model)) {
      return { who: 'who-wb', label: 'WorkBuddy' };
    }
    if (/Official/i.test(model)) return { who: 'who-trae', label: 'Trae' };
    return { who: 'who-task', label: '其他' };
  };

  const cTotals = client?.totals;
  const cModels = client?.models || [];
  const cDaily = client?.data || [];
  const cAvgPerReq = cTotals && cTotals.requests ? cTotals.tokens / cTotals.requests : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg-track" role="group" aria-label="统计区间">
          {DAY_OPTIONS.map((d) => (
            <button key={d} type="button" className="seg-tab" aria-selected={days === d} onClick={() => setDays(d)}>
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

      {source === 'gateway' && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <StatCard
              label="请求总数"
              value={fmtInt(req)}
              hint={`失败 ${fmtInt(errN)} 次（${req ? ((errN / req) * 100).toFixed(1) : '0.0'}%）`}
            />
            <StatCard label="已计量 Token" value={fmtTokens(tok)} hint={`${fmtInt(met)} 次请求带回 usage`} accent="acc" />
            <StatCard
              label="计量覆盖率"
              value={`${cov.toFixed(1)}%`}
              hint={cov < 50 ? '超过半数请求无 token 数据' : cov < 90 ? '存在部分未计量请求' : '覆盖良好'}
              accent={cov < 90 ? 'warn' : undefined}
            />
            <StatCard label="单次均量" value={fmtTokens(Math.round(avgPerReq))} hint="仅按已计量请求计算，非全局均值" />
          </div>

          {req > 0 && cov < 90 && (
            <Note kind="warn" icon={ICON.alert}>
              <b>未计量的请求已从合计中排除，而非按 0 计入。</b>
              <br />
              近 {days} 日 {fmtInt(req)} 次请求中有 {fmtInt(req - met)} 次未带回 usage，无法计量。
              WorkBuddy 平台目前整体不上报 usage，该侧覆盖缺口属平台行为；要看真实用量请切到「客户端消耗」。
            </Note>
          )}

          <Panel
            title="已计量 Token 趋势"
            desc="柱高 = 当日已计量 token；灰柱表示当日请求全部未计量（无 token 数据，并非消耗为 0）。"
            bodyClass="px-5 py-4"
          >
            <BarChart
              series={[...daily].reverse().map((d) => ({ label: d.date, value: d.tokens, metered: d.metered }))}
              aria="每日已计量 token"
              showUnmeteredMark
            />
            <div className="legend">
              <span>
                <i style={{ background: '#047857' }} />
                已计量 token
              </span>
              <span>
                <i style={{ background: '#D1D5DB' }} />
                全部未计量
              </span>
            </div>
          </Panel>

          <Panel
            title="请求量与计量覆盖率"
            desc="实线为请求量（左轴），虚线为已计量占比（右轴）。虚线贴底说明该日请求基本无 token 数据。"
            bodyClass="px-5 py-4"
          >
            <CoverageChart series={daily} />
            <div className="legend">
              <span>
                <i style={{ background: '#047857' }} />
                请求量
              </span>
              <span>
                <i style={{ background: '#B45309' }} />
                已计量占比
              </span>
            </div>
          </Panel>

          <Panel title="按模型明细" desc="已计量与未计量分列，避免把 0 当作真实用量参与比较。">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px] min-w-[880px]">
                <thead>
                  <tr>
                    <th className="th">模型</th>
                    <th className="th">平台</th>
                    <th className="th cell-num">请求</th>
                    <th className="th cell-num">已计量 Token</th>
                    <th className="th cell-num">未计量</th>
                    <th className="th cell-num">计量覆盖</th>
                    <th className="th cell-num">平均耗时</th>
                    <th className="th cell-num">工具调用</th>
                  </tr>
                </thead>
                <tbody>
                  {[...meteredModels, ...unmeteredModels].map((m) => {
                    const p = platOf(m.model);
                    const unm = m.unmetered ?? 0;
                    return (
                      <tr key={m.model} className="row-hover">
                        <td className="td font-medium text-ink">{m.model}</td>
                        <td className="td">
                          <span className={`who ${p.who}`}>{p.label}</span>
                        </td>
                        <td className="td cell-num">{fmtInt(m.requests)}</td>
                        <td className="td cell-num tabular-nums">
                          {m.tokens ? fmtTokens(m.tokens) : <span className="text-ink-faint">—</span>}
                        </td>
                        <td className={`td cell-num tabular-nums ${unm ? 'text-[#B45309]' : 'text-ink-faint'}`}>
                          {unm || '—'}
                        </td>
                        <td className="td cell-num">
                          <CoverageBar metered={m.metered ?? 0} total={m.requests} width={90} />
                        </td>
                        <td className="td cell-num text-ink-faint">
                          {m.avgDurationMs != null ? `${m.avgDurationMs}ms` : '—'}
                        </td>
                        <td className="td cell-num text-ink-faint">{m.toolCalls || '—'}</td>
                      </tr>
                    );
                  })}
                  {!models.length && (
                    <tr>
                      <td colSpan={8} className="text-center py-10 text-ink-soft text-[13px]">
                        暂无数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-2.5 border-t border-line text-[11.5px] text-ink-faint">
              未计量合计 {fmtInt(unmeteredReq)} 次请求 · {unmeteredModels.length} 个模型无 token 数据
            </div>
          </Panel>
        </>
      )}

      {source === 'client' && (
        <>
          {clientErr ? (
            <Note kind="warn" icon={ICON.alert}>
              <b>客户端消耗数据暂不可用。</b>
              <br />
              该视图依赖后端端点 /v1/admin/stats/client。若后端尚未更新到含该端点的版本，
              请求会被路由到转发面鉴权而返回 401，属预期现象而非账号问题。
              <br />
              <span className="text-ink-faint">原始响应：{clientErr}</span>
            </Note>
          ) : client && !client.available ? (
            <Note kind="warn" icon={ICON.alert}>
              <b>未找到本机会话日志。</b>
              <br />
              期望路径 {client.root || '%USERPROFILE%\\.workbuddy\\projects'}。
              该侧数据来自 WorkBuddy 客户端自身写入的日志，未安装或未使用过该客户端时为空。
            </Note>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
                <StatCard
                  label="调用次数"
                  value={fmtInt(cTotals?.requests)}
                  hint={`来自 ${client?.files ?? 0} 个会话日志文件`}
                />
                <StatCard label="Token 合计" value={fmtTokens(cTotals?.tokens)} hint="输入 + 输出，已按调用去重" accent="acc" />
                <StatCard
                  label="缓存命中率"
                  value={`${((cTotals?.cacheHitRate || 0) * 100).toFixed(1)}%`}
                  hint={`缓存读 ${fmtTokens(cTotals?.cacheRead)}，已含在输入内`}
                />
                <StatCard label="单次均量" value={fmtTokens(Math.round(cAvgPerReq))} hint="按全部调用计算，非仅已计量" />
              </div>

              <Note kind="info" icon={ICON.info}>
                <b>本侧为本机全局汇总，不做账号归因。</b>
                <br />
                客户端日志不记录账号标识，无法判断某次调用走的是池中哪个账号，因此不按账号拆分，
                以免给出看似精确、实则错配的归因。仅扫描 usage 与时间戳，不读取消息正文。
              </Note>

              <Panel
                title="每日 Token 趋势"
                desc="柱高 = 当日全部调用的 token 合计。该侧无「未计量」概念，柱高即为实际用量。"
                bodyClass="px-5 py-4"
              >
                <BarChart
                  series={[...cDaily].reverse().map((d) => ({ label: d.date, value: d.tokens }))}
                  aria="每日客户端 token"
                />
                <div className="legend">
                  <span>
                    <i style={{ background: '#047857' }} />
                    客户端 token
                  </span>
                </div>
              </Panel>

              <Panel title="按模型明细" desc={`近 ${days} 日，按 token 降序。`}>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px] min-w-[620px]">
                    <thead>
                      <tr>
                        <th className="th">模型</th>
                        <th className="th cell-num">调用</th>
                        <th className="th cell-num">Token</th>
                        <th className="th cell-num">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cModels.map((m) => {
                        const totalTok = cTotals?.tokens || 0;
                        const pct = totalTok ? (m.tokens / totalTok) * 100 : 0;
                        return (
                          <tr key={m.model} className="row-hover">
                            <td className="td font-medium text-ink">{m.model}</td>
                            <td className="td cell-num">{fmtInt(m.requests)}</td>
                            <td className="td cell-num tabular-nums">{fmtTokens(m.tokens)}</td>
                            <td className="td cell-num">
                              <span className="inline-flex items-center justify-end gap-2">
                                <span className="bar" style={{ maxWidth: 160, width: '100%' }}>
                                  <i style={{ width: `${pct}%` }} />
                                </span>
                                <span className="text-[11.5px] text-ink-faint tabular-nums shrink-0 w-11 text-right">
                                  {pct.toFixed(1)}%
                                </span>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {!cModels.length && (
                        <tr>
                          <td colSpan={4} className="text-center py-10 text-ink-soft text-[13px]">
                            近 {days} 日无调用记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-5 py-2.5 border-t border-line text-[11.5px] text-ink-faint">
                  扫描 {client?.files ?? 0} 个文件 · 本次复用缓存 {client?.cachedFiles ?? 0} 个、新解析 {client?.parsedFiles ?? 0} 个
                </div>
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}
