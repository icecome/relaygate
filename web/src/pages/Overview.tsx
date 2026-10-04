import { useCallback, useEffect, useRef, useState } from 'react';
import StatCard from '../components/StatCard';
import { Panel, Note, ActionRow, WhoTag, ICON } from '../components/ui';
import { OPS } from '../lib/ops';
import useHeartbeat from '../lib/useHeartbeat';
import { useSummary } from '../stores/useSummary';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { getStatus, getStatsDaily, runScheduler, type DailyStat } from '../api/admin';
import { fmtBalance, fmtTokens, fmtInt, relTime, untilTime, strategyLabel } from '../lib/format';
import type { Account, AccountState, PoolAccount } from '../api/types';
import StatusDot from '../components/StatusDot';

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
  const [status, setStatus] = useState<StatusShape | null>(null);
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [busy, setBusy] = useState('');
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
  }, [loadStatus, loadDaily, refresh]);

  // 可见性感知的周期刷新：后台暂停，切回立即拉取（lib/useHeartbeat）
  useHeartbeat(loadAll, 30_000);

  useEffect(() => {
    loadStatus();
    loadDaily();
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

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard
          label="账号池余额"
          value={fmtBalance(totalBal)}
          hint={`${enabledN} 个启用账号 · 含临期部分`}
          accent="acc"
        />
        <StatCard label="近 14 日请求" value={fmtInt(req14)} hint={`日均 ${fmtInt(Math.round(req14 / 14))} 次`} />
        <StatCard
          label="近 14 日 Token"
          value={fmtTokens(tok14)}
          hint={`仅统计已计量请求，覆盖率 ${cov14.toFixed(1)}%`}
          accent={cov14 < 50 ? 'warn' : undefined}
        />
        <StatCard
          label="执行中队列"
          value={pool?.waiters?.count ?? 0}
          hint={`并发上限 ${pool?.maxInFlight ?? '—'}/账号 · 等待位 ${pool?.waiters?.limit ?? '—'}`}
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
        desc={`调度策略 ${strategyLabel(pool?.strategy)} · 按余额从低到高选取，避免单账号过快耗尽`}
        right={
          <span className="text-xs text-ink-faint tabular-nums">{all.length} 个账号</span>
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
              {all.slice(0, 8).map((a: Account) => {
                const isWb = String(a.edition ?? a.source ?? '').includes('workbuddy');
                const cooling = a.coolUntil && new Date(a.coolUntil).getTime() > Date.now();
                return (
                  <tr key={a.id} className="row-hover">
                    <td className="td">
                      <WhoTag who={isWb ? 'who-wb' : 'who-trae'}>{isWb ? 'WorkBuddy' : 'Trae'}</WhoTag>
                    </td>
                    <td className="td">
                      <div className="font-medium text-ink">{a.label ?? a.id}</div>
                      <div className="acct-id">{a.id}</div>
                    </td>
                    <td className="td">
                      <StatusDot state={(!a.enabled ? 'off' : cooling ? 'cool' : 'ok') as AccountState} />
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
