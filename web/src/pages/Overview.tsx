import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StatCard from '../components/StatCard';
import { Panel, Note, ActionRow, WhoTag, ICON } from '../components/ui';
import { OPS } from '../lib/ops';
import useHeartbeat from '../lib/useHeartbeat';
import { useSummary } from '../stores/useSummary';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { getStatus, getStatsDaily, runScheduler, type DailyStat } from '../api/admin';
import { fmtBalance, fmtTokens, fmtInt, relTime, untilTime, strategyLabel } from '../lib/format';
import type { Account, PoolAccount } from '../api/types';
import StatusDot from '../components/StatusDot';
import { accountState } from '../api/types';

/** /status 的关键片段。字段多且后端无类型定义，此处只声明用到的部分 */
interface StatusShape {
  accounts?: { total?: number; enabled?: number; cooling?: number };
  pool?: {
    strategy?: string;
    maxInFlight?: number;
    waiters?: { count?: number; limit?: number };
    accounts?: PoolAccount[];
  };
  scheduler?: {
    enabled?: boolean;
    checkinHour?: number;
    checkinMinute?: number;
    keepaliveHour?: number;
    keepaliveMinute?: number;
    lastCheckinAt?: string | null;
    lastKeepaliveAt?: string | null;
    lastRotateAt?: string | null;
    lastGrowthAt?: string | null;
    nextCheckinAt?: string | null;
    nextKeepaliveAt?: string | null;
    nextGrowthAt?: string | null;
    rotateSettings?: { intervalMinutes?: number };
    growthPollIntervalHours?: number;
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export default function Overview() {
  const { key } = useAuth();
  const { data, refresh } = useSummary();
  const toast = useToast();
  const nav = useNavigate();
  const [status, setStatus] = useState<StatusShape | null>(null);
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [busy, setBusy] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const alive = useRef(true);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, []);

  const loadStatus = useCallback(() => {
    if (!key) return;
    getStatus(key)
      .then((d) => setStatus(d as StatusShape))
      .catch(() => setStatus(null));
  }, [key]);

  const loadDaily = useCallback(() => {
    if (!key) return;
    getStatsDaily(14, key)
      .then((d) => setDaily(d.data || []))
      .catch(() => setDaily([]));
  }, [key]);

  const loadAll = useCallback(() => {
    loadStatus();
    loadDaily();
    refresh();
    setLastSync(new Date().toISOString());
  }, [loadStatus, loadDaily, refresh]);

  // 可见性感知的周期刷新：后台暂停，切回立即拉取（lib/useHeartbeat）
  useHeartbeat(loadAll, 30_000);

  /** 「上次刷新 · 12 秒前」需要随时间自然老化，而数据刷新本身不触发重渲染。
   *  取 1 秒节拍仅用于刷新这一个时间文案，不带动任何数据请求。 */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadStatus();
    loadDaily();
    setLastSync(new Date().toISOString());
  }, [loadStatus, loadDaily]);

  const all = data?.accounts ?? [];
  const sched = status?.scheduler;
  const pool = status?.pool;

  /** 在途数只在 /status 的 pool 快照里，按 id 建索引供账号表使用 */
  const inFlightOf = new Map<string, number>();
  for (const p of pool?.accounts ?? []) {
    if (p.inFlight) inFlightOf.set(p.id, p.inFlight);
  }

  const totalBal = all.reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);
  const enabledN = status?.accounts?.enabled ?? all.filter((a) => a.enabled).length;
  const req14 = daily.reduce((s, d) => s + d.requests, 0);
  const tok14 = daily.reduce((s, d) => s + d.tokens, 0);
  const met14 = daily.reduce((s, d) => s + (d.metered ?? 0), 0);
  const cov14 = req14 ? (met14 / req14) * 100 : 0;

  /** 需干预量：直接取 /summary 的聚合字段，不从 accounts 数组重复推导。
   *  这三项是态势台的核心——它们回答"现在有多少事等着人处理"。 */
  const coolingN = data?.cooling ?? 0;
  const disabledN = data?.disabled ?? 0;

  /** 「待处理」= 停用（需人工恢复）+ 有错误（需排查），用 id 集合去重，
   *  避免同一账号（既停用又报错）被数两次。
   *  刻意不含「冷却」——冷却到点自动解冻，不需要人动手，故单列一卡但不计入待处理。 */
  const alertIds = new Set(all.filter((a) => accountState(a) === 'off' || (a.errorCount || 0) > 0).map((a) => a.id));
  const alertN = alertIds.size;

  /** 异常优先：停用 > 冷却 > 有错误 > 正常，同级按错误数降序。
   *  概览只列前 8 个，若不排序则会淹没在健康账号里、看不见需要处理的行。 */
  const rankOf = (a: Account) => (accountState(a) === 'off' ? 0 : accountState(a) === 'cool' ? 1 : (a.errorCount || 0) > 0 ? 2 : 3);
  const focusRows = [...all]
    .sort((x, y) => rankOf(x) - rankOf(y) || (y.errorCount || 0) - (x.errorCount || 0))
    .slice(0, 8);
  const abnormalN = all.filter((a) => rankOf(a) < 3).length;

  /** 执行链：调度器按固定时刻推进的四个动作 */
  const chain = [
    {
      key: 'checkin',
      name: '每日签到链',
      at: sched ? `${pad2(sched.checkinHour ?? 0)}:${pad2(sched.checkinMinute ?? 0)}` : '—',
      last: sched?.lastCheckinAt,
      next: sched?.nextCheckinAt,
      op: 'checkin',
    },
    {
      key: 'keepalive',
      name: '令牌保活',
      at: sched ? `${pad2(sched.keepaliveHour ?? 0)}:${pad2(sched.keepaliveMinute ?? 0)}` : '—',
      last: sched?.lastKeepaliveAt,
      next: sched?.nextKeepaliveAt,
      op: 'keepalive',
    },
    {
      key: 'rotate',
      name: '客户端账号轮换',
      at: sched?.rotateSettings?.intervalMinutes ? `每 ${sched.rotateSettings.intervalMinutes} 分钟` : '—',
      last: sched?.lastRotateAt,
      next: null,
      op: 'rotate',
    },
    {
      key: 'growth',
      name: '成长中心自动化',
      at: sched?.growthPollIntervalHours ? `每 ${sched.growthPollIntervalHours} 小时` : '—',
      last: sched?.lastGrowthAt,
      next: sched?.nextGrowthAt,
      op: 'growth',
    },
  ];

  /** 调度器可直接触发的三个动作。轮换与成长走各自端点，不在本处触发。 */
  const runnable = (op: string) => op === 'checkin' || op === 'keepalive' || op === 'balance';

  const runOp = async (op: string) => {
    if (!key || !runnable(op)) return;
    setBusy(op);
    try {
      await runScheduler(op as 'checkin' | 'keepalive' | 'balance', key);
      if (!alive.current) return;
      toast(`已触发：${OPS[op].name}`, 'ok');
      // 调度器动作异步推进，延后一拍再拉取，避免读到未更新的快照
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        if (!alive.current) return;
        loadStatus();
        loadDaily();
        refresh();
      }, 1200);
    } catch (e) {
      if (alive.current) toast(`执行失败：${(e as Error).message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-4">
      {/* 心跳条：让"看板"与"挂了"在视觉上可区分。
          没有上次刷新时间，一张静态截图和断网没有区别。 */}
      <div className="flex items-center gap-2 text-aux text-ink-faint">
        <span
          className={`inline-block w-[7px] h-[7px] rounded-full ${
            lastSync ? (alertN > 0 ? 'bg-warn' : 'bg-acc') : 'bg-ink-faint'
          }`}
          aria-hidden
        />
        <span>数据每 30 秒自动刷新</span>
        <span className="text-line-strong">·</span>
        <span>
          {lastSync ? (
            <>
              上次刷新{' '}
              <b className="text-ink-soft font-medium tabular-nums">
                {relTime(lastSync)}
              </b>
            </>
          ) : (
            '尚未连接'
          )}
        </span>
        <button type="button" className="btn-quiet ml-auto" onClick={loadAll} disabled={!key}>
          立即刷新
        </button>
      </div>

      {/* 今日执行链：取代原先散落各处的多个签到/刷新入口 */}
      <Panel
        title="今日执行链"
        desc="调度器按固定时刻串行推进的运维动作。每个动作的作用对象已显式标注。"
        right={
          <span className={sched?.enabled ? 'pill-ok' : 'pill-muted'}>
            {sched?.enabled ? '调度器运行中' : '调度器已停用'}
          </span>
        }
        bodyClass="px-5 pb-2"
      >
        {chain.map((c) => {
          const op = OPS[c.op];
          return (
            <ActionRow
              key={c.key}
              name={c.name}
              tag={<WhoTag who={op.who}>作用于{op.target}</WhoTag>}
              meta={<span className="pill-muted mono text-[10.5px]">{c.at}</span>}
              targetText={
                <>
                  上次执行：<b className="text-ink">{relTime(c.last ?? null)}</b>
                  {c.next ? (
                    <>
                      {' '}
                      · 下次：<b className="text-ink">{untilTime(c.next)}</b>
                    </>
                  ) : null}
                </>
              }
              side={op.side}
              actions={
                <>
                  <button
                    type="button"
                    className="btn-quiet text-xs"
                    onClick={() => toast(`${op.name}：${op.targetText}`)}
                  >
                    作用对象
                  </button>
                  {runnable(c.op) ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy === c.op}
                      onClick={() => runOp(c.op)}
                    >
                      {busy === c.op ? '执行中…' : '立即执行'}
                    </button>
                  ) : (
                    <span className="text-[11.5px] text-ink-faint" title={op.note || '该动作不提供独立触发入口'}>
                      按周期自动运行
                    </span>
                  )}
                </>
              }
            />
          );
        })}
      </Panel>

      {/* ---- 态势读数：首屏必须先回答"有没有事、有多少事" ----
          顺序即优先级：待处理/冷却 两个"要人管的量"排在最前，
          健康指标（在线/额度/队列）退居其后。全灰的看板等于没有优先级。
          6 张卡单一网格：桌面 3×2 均衡，小屏 2 列。
          刻意不含「已停用」独立卡——它是「待处理」的子集，并列同色会构成视觉重复；
          其数值并入「待处理」的 hint 作为构成说明。 */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard
          label="待处理"
          value={alertN}
          accent={alertN > 0 ? 'danger' : 'default'}
          todo={alertN > 0}
          clickable={alertN > 0}
          onClick={() => nav('/accounts')}
          hint={
            alertN > 0
              ? `停用 ${disabledN} · 报错 ${alertN - disabledN} · 点击处理`
              : '全部正常'
          }
        />
        <StatCard
          label="冷却中"
          value={coolingN}
          accent={coolingN > 0 ? 'warn' : 'default'}
          todo={coolingN > 0}
          hint={coolingN > 0 ? '限流退避，到期自动恢复' : '无冷却账号'}
        />
        <StatCard label="在线可用" value={enabledN} hint={`共 ${all.length} 个账号`} />
        <StatCard
          label="额度余量"
          value={fmtBalance(totalBal)}
          hint="全池余额合计 · 含临期部分"
        />
        <StatCard
          label="执行中队列"
          value={pool?.waiters?.count ?? 0}
          hint={`并发上限 ${pool?.maxInFlight ?? '—'}/账号 · 等待位 ${pool?.waiters?.limit ?? '—'}`}
        />
        <StatCard
          label="近 14 日用量"
          value={fmtTokens(tok14)}
          hint={`${fmtInt(req14)} 次请求 · 日均 ${fmtInt(Math.round(req14 / 14))} 次${
            cov14 > 0 && cov14 < 90 ? ` · 计量覆盖 ${cov14.toFixed(1)}%` : ''
          }`}
        />
      </div>

      {/* 结构性盲区必须在概览露出，否则会被误读成「用量很低」 */}
      {req14 > 0 && cov14 < 90 && (
        <Note kind="warn" icon={ICON.alert}>
          <b>Token 计量存在结构性盲区，请勿直接横向比较模型用量。</b>
          <br />
          近 14 日 {fmtInt(req14)} 次请求中仅 {fmtInt(met14)} 次带回 token 用量（<b>{cov14.toFixed(1)}%</b>）。
          Trae 体系覆盖良好，<b>WorkBuddy 体系当前完全不上报 token</b>。
          统计页将「未计量」单独标记，不会让 0 混入总量。
        </Note>
      )}

      <Panel
        title="账号池"
        desc={`调度策略 ${strategyLabel(pool?.strategy)} · 异常账号优先排列，便于先处理需要干预的行`}
        right={
          <span className="text-xs text-ink-faint tabular-nums">
            {abnormalN > 0 ? (
              <span className="text-warn font-medium">{abnormalN} 个需注意 · </span>
            ) : null}
            共 {all.length} 个
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px] min-w-[720px]">
            <thead>
              <tr>
                <th className="th">平台</th>
                <th className="th">账号</th>
                <th className="th">状态</th>
                <th className="th cell-num">余额</th>
                <th className="th cell-num">错误</th>
                <th className="th cell-num">在途</th>
              </tr>
            </thead>
            <tbody>
              {focusRows.map((a: Account) => {
                const isWb = String(a.edition ?? a.source ?? '').includes('workbuddy');
                const st = accountState(a);
                // 异常行染背景色 = 把"要处理的行"从白底里抬起来。
                // 与首屏 KPI 同色系：停用淡红、冷却淡橙、正常白/二级表面。
                const rowBg =
                  st === 'off'
                    ? 'bg-[#FEF5F5]'
                    : st === 'cool'
                      ? 'bg-[#FFF8F2]'
                      : '';
                return (
                  <tr key={a.id} className={`row-hover ${rowBg}`}>
                    <td className="td">
                      <WhoTag who={isWb ? 'who-wb' : 'who-trae'}>{isWb ? 'WorkBuddy' : 'Trae'}</WhoTag>
                    </td>
                    <td className="td">
                      <div className="font-medium text-ink">{a.label ?? a.id}</div>
                      <div className="acct-id">{a.id}</div>
                    </td>
                    <td className="td">
                      <StatusDot state={accountState(a)} />
                    </td>
                    <td className="td cell-num tabular-nums">{fmtBalance(a.balance)}</td>
                    <td className={`td cell-num ${(a.errorCount || 0) > 0 ? 'text-danger font-semibold' : 'text-ink-faint'}`}>
                      {a.errorCount || 0}
                    </td>
                    <td className="td cell-num text-ink-faint">{inFlightOf.get(a.id) ?? 0}</td>
                  </tr>
                );
              })}
              {!all.length && (
                <tr>
                  <td colSpan={6} className="text-center text-ink-soft py-10 text-xs">
                    {key ? '暂无账号，请在「账号」栏目导入。' : '请先在设置页保存登录密钥。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
