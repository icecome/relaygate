import { useEffect, useRef, useState } from 'react';
import { useToast } from './Toast';
import { usePrompt } from './Prompt';
import { useAuth } from '../stores/useAuth';
import { useSummary } from '../stores/useSummary';
import {
  growthStatusAll,
  growthAuto,
  growthDepart,
  growthConfig,
  growthClaim,
  growthLastRun,
  growthOverview,
  growthProgress,
  type StatusAllRow,
  type TravelLocation,
  type LastRun,
  type GrowthOverviewRow,
  type GrowthProgress,
} from '../api/catTrip';

/**
 * WorkBuddy 成长中心：旅行状态、成长总览与一键自动化。
 * 该平台的独有能力，与账号池解耦，单独成组件挂在 WorkBuddy 子栏下。
 */
export default function GrowthPanel() {
  const { key } = useAuth();
  const { accountsOf } = useSummary();
  const toast = useToast();
  const prompt = usePrompt();

  const accts = accountsOf('workbuddy');
  const [growthRows, setGrowthRows] = useState<StatusAllRow[] | null>(null);
  const [overview, setOverview] = useState<GrowthOverviewRow[] | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [locations, setLocations] = useState<TravelLocation[]>([]);
  const [loadingGrowth, setLoadingGrowth] = useState(false);
  const [autoProgress, setAutoProgress] = useState<GrowthProgress | null>(null);
  const alive = useRef(true);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (sleepTimer.current) clearTimeout(sleepTimer.current);
    };
  }, []);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      sleepTimer.current = setTimeout(() => {
        sleepTimer.current = null;
        resolve();
      }, ms);
    });

  const loadGrowth = async (): Promise<void> => {
    if (!key) return;
    setLoadingGrowth(true);
    try {
      const [r, cfg, ov, lr] = await Promise.all([
        growthStatusAll(key),
        accts.length ? growthConfig(accts[0].id, key) : Promise.resolve(null),
        growthOverview(key),
        growthLastRun(key),
      ]);
      setGrowthRows(r.data);
      setOverview(ov.data);
      setLastRun(lr);
      if (cfg && cfg.ok) setLocations(cfg.locations);
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setLoadingGrowth(false);
    }
  };

  /** 轮询后台自动化任务进度至完成。 */
  const pollAuto = async (taskId: string): Promise<void> => {
    if (!key) return;
    let p: GrowthProgress | null = null;
    try {
      for (let i = 0; i < 240; i++) {
        if (!alive.current) return;
        p = await growthProgress(taskId, key);
        if (!alive.current) return;
        setAutoProgress(p);
        if (!p.running) break;
        await sleep(2500);
        if (!alive.current) return;
      }
    } catch (e) {
      if (alive.current) toast(`进度查询失败：${(e as Error).message}`, 'err');
    } finally {
      if (alive.current) {
        if (p && p.running) toast('查询超时，可在任务日志查看结果', 'warn');
        loadGrowth();
      }
    }
  };

  const runAuto = async (): Promise<void> => {
    const ok = await prompt({
      title: '成长中心一键自动化',
      message: `对 ${accts.length} 个启用账号执行：旅行(领奖/派猫) + 任务接单领奖 + 补登 + 连登兑换 + 抽奖 + 能量开盲盒。`,
      okText: '执行',
    });
    if (!ok) return;
    setAutoProgress(null);
    try {
      const r = await growthAuto({}, key);
      toast(`自动化已启动（${r.taskId}），可在下方查看进度`, 'ok');
      loadGrowth();
      await pollAuto(r.taskId);
    } catch (e) {
      toast(`启动失败：${(e as Error).message}`, 'err');
    }
  };

  const departOne = async (accountId: string, label?: string | null): Promise<void> => {
    const loc = locations[0];
    if (!loc) {
      toast('先获取地点目录', 'err');
      return;
    }
    const ok = await prompt({
      title: `派「${label ?? accountId}」出发`,
      message: `地点「${loc.name}」时长 1-4h，奖励 ${loc.rewardCreditMin}-${loc.rewardCreditMax}，将消耗当日次数。`,
      okText: '出发',
    });
    if (!ok) return;
    try {
      const dur = loc.durationHoursMax ?? 4;
      const r = await growthDepart({ accountId, location_id: loc.id, duration_hours: dur }, key);
      if (r.ok) toast(`${label ?? accountId} 已出发${r.rewardCredit != null ? `（预计 +${r.rewardCredit}）` : ''}`, 'ok');
      else toast(`${label ?? accountId} 未出发：${r.reason || r.result || ''}`);
      loadGrowth();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const claimOne = async (accountId: string, label?: string | null): Promise<void> => {
    try {
      const r = await growthClaim(accountId, key);
      if (r.ok) toast(`${label ?? accountId} 奖励已领取${r.rewardCredit != null ? `（+${r.rewardCredit}）` : ''}`, 'ok');
      else toast(`${label ?? accountId} 暂未到账：${r.reason || r.result || ''}`);
      loadGrowth();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="btn btn-ghost" onClick={() => void loadGrowth()}>
          成长旅行
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void runAuto()}>
          成长中心自动化
        </button>
        <span className="text-xs text-ink-faint">
          读取上游旅行状态（只读）；可单账号领奖/出发，或一键自动化。
        </span>
      </div>

      {lastRun && lastRun.ranAt && (
        <div className="panel px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <span className={`w-2 h-2 rounded-full ${lastRun.failCount ? 'bg-warn' : 'bg-acc'}`} aria-hidden />
              上次自动化
            </span>
            <span className="text-ink-faint tabular-nums">{fmtTs(Math.floor(new Date(lastRun.ranAt).getTime() / 1000))}</span>
            <span className={lastRun.failCount ? 'text-warn font-medium' : 'text-acc-hover font-medium'}>
              {lastRun.okCount ?? 0}/{lastRun.total ?? 0} 账号正常
            </span>
            {lastRun.actions && lastRun.actions.length > 0 && (
              <span className="text-ink-soft truncate">
                {lastRun.actions.slice(0, 3).join(' · ')}
                {lastRun.actions.length > 3 ? ` 等 ${lastRun.actions.length} 项` : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {autoProgress && (
        <div className="panel px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-sm font-semibold text-ink">
              成长中心自动化进度
              {autoProgress.running && (
                <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-acc-hover font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-acc animate-pulse inline-block" aria-hidden />
                  执行中
                </span>
              )}
            </div>
            <span className="text-xs text-ink-faint tabular-nums">
              {autoProgress.doneCount}/{autoProgress.total} 账号 · 正常 {autoProgress.okCount} · 失败 {autoProgress.failCount}
            </span>
          </div>
          <div className="h-[6px] rounded-full bg-[#EEF0F2] overflow-hidden mb-3">
            <div
              className="h-full rounded-full bg-acc transition-[width] duration-500 ease-out"
              style={{ width: `${autoProgress.total ? Math.round((autoProgress.doneCount / autoProgress.total) * 100) : 0}%` }}
            />
          </div>
          {autoProgress.currentAccount && autoProgress.running && (
            <div className="text-xs text-ink-soft mb-3">正在处理：{autoProgress.currentAccount}</div>
          )}
          {!autoProgress.running && autoProgress.error && <div className="text-xs text-danger mb-3">{autoProgress.error}</div>}
          {!autoProgress.running && autoProgress.results.length > 0 && (
            <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
              {autoProgress.results.map((r) => (
                <div key={r.accountId} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-medium ${r.ok ? 'text-acc-hover' : 'text-warn'}`}>
                      {r.label || r.accountId}
                    </span>
                    <span className={`${r.ok ? 'pill-ok' : 'pill-danger'}`}>{r.ok ? '正常' : '有失败'}</span>
                  </div>
                  {r.actions.filter((a) => a.ok && !a.skip).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-soft">
                      {r.actions
                        .filter((a) => a.ok && !a.skip)
                        .map((a, i) => (
                          <span key={i}>· {a.msg}</span>
                        ))}
                    </div>
                  )}
                  {r.actions.filter((a) => !a.ok).length > 0 && (
                    <div className="mt-1 text-[11px] text-warn">
                      {r.actions
                        .filter((a) => !a.ok)
                        .map((a, i) => (
                          <div key={i}>
                            · {a.seg}：{a.msg}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-semibold text-ink">WorkBuddy 成长旅行</div>
              <div className="text-xs text-ink-faint mt-0.5">
                读取上游旅行状态（只读）；可单账号领奖/出发，或一键「成长中心自动化」。
              </div>
            </div>
            <span className="text-xs text-ink-faint tabular-nums">
              {loadingGrowth ? '加载中…' : growthRows ? `${growthRows.length} 个账号` : ''}
            </span>
          </div>
          {growthRows && growthRows.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
              {growthRows.map((g) => {
                const traveling = g.ok && g.state === 'traveling';
                const arrived = g.ok && g.state === 'arrived';
                return (
                  <div key={g.accountId} className="card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-ink truncate flex items-center gap-1.5">
                        <span
                          className={`inline-flex w-5 h-5 rounded items-center justify-center text-[10px] font-semibold text-white ${
                            traveling ? 'bg-acc' : arrived ? 'bg-warn' : 'bg-ink-soft/40'
                          }`}
                        >
                          W
                        </span>
                        {g.label}
                      </div>
                      {g.ok ? (
                        <span
                          className={`${g.state === 'arrived' ? 'pill-warn' : g.state === 'traveling' ? 'pill-ok' : 'pill-muted'}`}
                        >
                          {stateLabel(g.state)}
                        </span>
                      ) : (
                        <span className="pill-danger">获取失败</span>
                      )}
                    </div>
                    {g.ok && (
                      <div className="mt-2.5 space-y-1.5 text-[12px]">
                        <div className="flex justify-between">
                          <span className="text-ink-faint">地点</span>
                          <span className="text-ink">
                            {g.location?.name || '—'}
                            {g.rewardCredit ? `（预计 +${g.rewardCredit}）` : ''}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-faint">发起时间</span>
                          <span className="text-ink tabular-nums">{fmtTs(g.departAt)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-faint">旅行时长</span>
                          <span className="text-ink tabular-nums">
                            {g.location?.duration_hours ? `${g.location.duration_hours} 小时` : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-ink-faint">预计结束</span>
                          <span className="text-ink tabular-nums">{fmtTs(g.arriveAt)}</span>
                        </div>
                        {g.ok && g.state === 'traveling' && g.arriveAt && g.serverNow && (
                          <div className="flex justify-between items-center">
                            <span className="text-ink-faint">剩余</span>
                            <span className="inline-flex items-center gap-1.5 text-warn tabular-nums font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-acc animate-pulse inline-block" aria-hidden />
                              {fmtRemain(g.arriveAt, g.serverNow)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-ink-faint">今日次数</span>
                          <span className={`tabular-nums ${g.dailyLimitReached ? 'text-warn font-medium' : 'text-acc-hover'}`}>
                            {g.dailyLimitReached ? '已派过' : '可出发'}
                          </span>
                        </div>
                      </div>
                    )}
                    {!g.ok && <div className="text-[11px] text-ink-faint mt-1.5 mb-2 break-all">{g.reason}</div>}
                    <div className="flex gap-1.5 mt-3">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={!g.ok || g.state !== 'idle' || g.dailyLimitReached}
                        onClick={() => void departOne(g.accountId, g.label)}
                      >
                        出发
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!g.ok || g.state !== 'arrived'}
                        onClick={() => void claimOne(g.accountId, g.label)}
                      >
                        领奖
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {growthRows && growthRows.length === 0 && (
            <div className="text-xs text-ink-faint">无启用账号，先导入并启用 WorkBuddy 账号。</div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-semibold text-ink">成长中心总览</div>
              <div className="text-xs text-ink-faint mt-0.5">
                Buddy 身份 · 能量（满 10 开盲盒）· 连登天数 · 补登卡 · 抽奖次数。
              </div>
            </div>
          </div>
          {overview && overview.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
              {overview.map((o) => (
                <div key={o.accountId} className="card px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-ink truncate">{o.label}</div>
                    {o.ok ? (
                      <span className="pill-ok">
                        {o.buddyName || '—'}
                        {o.rarity ? ` · ${o.rarity}` : ''}
                      </span>
                    ) : (
                      <span className="pill-danger">获取失败</span>
                    )}
                  </div>
                  {o.ok && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] mt-2.5">
                      <div className="flex justify-between">
                        <span className="text-ink-faint">能量</span>
                        <span className={`tabular-nums ${o.affordable ? 'text-acc-hover font-medium' : 'text-ink'}`}>
                          {o.energy ?? '—'}
                          {o.affordable ? ` (可开${o.affordable})` : ''}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-faint">连登</span>
                        <span className="text-ink tabular-nums">{o.streakDays != null ? `${o.streakDays} 天` : '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-faint">补登卡</span>
                        <span className="text-ink tabular-nums">{o.makeupCards ?? '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-faint">抽奖次数</span>
                        <span className={`tabular-nums ${o.lotteryChances ? 'text-acc-hover font-medium' : 'text-ink'}`}>
                          {o.lotteryChances ?? 0}
                        </span>
                      </div>
                    </div>
                  )}
                  {!o.ok && <div className="text-[11px] text-ink-faint mt-1.5 break-all">{o.reason}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-faint">
              {loadingGrowth ? '加载中…' : '点「成长旅行」刷新以载入总览。'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 秒级时间戳 → 本地可读时间；空返回 '—'。 */
function fmtTs(sec?: number | null): string {
  if (sec == null || sec <= 0) return '—';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 上游 state → 中文状态。权威三态：idle / traveling / arrived。 */
function stateLabel(state?: string): string {
  if (state === 'arrived') return '已到达·待领取';
  if (state === 'traveling') return '旅行中';
  if (state === 'idle') return '空闲';
  return state || '—';
}

/** 到达倒计时：用服务端时间戳算，避免本地时钟偏差。 */
function fmtRemain(arriveAt?: number | null, serverNow?: number | null): string {
  if (!arriveAt) return '—';
  const now = serverNow || Math.floor(Date.now() / 1000);
  const secs = Math.max(0, arriveAt - now);
  if (secs === 0) return '已到达';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h} 小时 ${m} 分后到达` : `${m} 分后到达`;
}
