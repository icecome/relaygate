/**
 * Raccoon 接入弹窗：面板承载扫码登录 + 已登录账号的运营操作。
 *
 * ## 为什么必须由面板承载登录
 *
 * 本机没有 Raccoon 官方桌面客户端可读凭据（不像 WorkBuddy/ZCode/Qoder），
 * 而官方那条 `office-raccoon://auth/callback` 自定义协议回调**服务端进程收不到**，
 * `/code/authorize` 的回调地址又写死改不成 localhost。参考项目实测后的解法是
 * 「本地生成 code + 自行轮询」——本弹窗就是那条链路的界面：
 * 后端生成 code 与二维码 → 用户微信扫码 → 面板轮询 → 成功后账号落库。
 *
 * ## 二维码为什么是 `<svg><path>` 而不是 `<img src=...>`
 *
 * 二维码内容含**一次性登录票据**。若交给第三方二维码图片服务生成，等于把票据
 * 送出去；而 `<img>` 又无法携带管理密钥。故后端用零依赖编码器直接产出
 * SVG 的 path 属性，前端只渲染一个属性字符串——既不出网，也不需要
 * `dangerouslySetInnerHTML`（无注入面）。
 *
 * ## 两条必须记住的语义
 *
 * 1. **每日 300 积分没有端点**（服务端按日自动发），本弹窗**不提供签到按钮**；
 *    能领的只有一次性的「桌面端登录奖励」，且它幂等（已领过返回 already）。
 * 2. 轮询的 `pending` 是**兜底**状态（未知状态与网络抖动都归到它），
 *    界面不能把它当成失败停止轮询，也不能把 `logging` 当成已完成。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { runAction } from '../../shared/api/action';
import {
  raccoonAccounts,
  raccoonCancelLogin,
  raccoonClaimReward,
  raccoonDeleteAccount,
  raccoonModels,
  raccoonPollLogin,
  raccoonRefreshPoints,
  raccoonRefreshToken,
  raccoonStartLogin,
  type RaccoonAccount,
  type RaccoonLoginSession,
} from '../../shared/api/raccoon';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Button, Chip, LoadingBlock, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 扫码阶段的界面状态。 */
type Phase = 'idle' | 'waiting' | 'scanned' | 'done' | 'failed';

export function ImportRaccoonDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [session, setSession] = useState<RaccoonLoginSession | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<RaccoonAccount[] | null>(null);
  const [models, setModels] = useState<{ source: string; count: number } | null>(null);
  /** 在途轮询标记：2 秒一次 + 用户可能开两个标签页，不能并发打上游 */
  const polling = useRef(false);
  const sessionRef = useRef<RaccoonLoginSession | null>(null);
  sessionRef.current = session;

  const loadAccounts = useCallback(async () => {
    if (!key) return;
    try {
      const r = await raccoonAccounts(key);
      setAccounts(r.data ?? []);
    } catch {
      setAccounts([]);
    }
  }, [key]);

  /** 开启（或重开）一次扫码会话。 */
  const startSession = useCallback(async () => {
    if (!key) return;
    setError('');
    setPhase('idle');
    setBusy(true);
    try {
      const s = await raccoonStartLogin(key);
      setSession(s);
      setPhase('waiting');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '发起扫码登录失败');
      setPhase('failed');
    } finally {
      setBusy(false);
    }
  }, [key]);

  // 打开时：探测账号与模型目录，并发起扫码会话；关闭时：取消会话
  useEffect(() => {
    if (open) {
      void loadAccounts();
      void startSession();
      if (key) {
        raccoonModels(key)
          .then((m) => setModels({ source: m.source, count: m.data.length }))
          .catch(() => setModels(null));
      }
    } else {
      const s = sessionRef.current;
      if (s) void raccoonCancelLogin(s.sessionId, key).catch(() => {});
      setSession(null);
      setPhase('idle');
      setError('');
      setBusy(false);
    }
    // key 变化（重新登录面板）时也要重来
  }, [open, key, loadAccounts, startSession]);

  /**
   * 轮询循环。
   *
   * 依赖 `open` 与 `session.sessionId`：会话一变（含 canceled 后换新码）就重启定时器。
   * `phase` 不放进依赖，否则每次状态变化都会重建定时器（轮询间隔会被打乱）。
   */
  useEffect(() => {
    if (!open || !session) return;
    const { sessionId, pollIntervalMs } = session;
    let active = true;

    async function tick() {
      if (polling.current) return;
      polling.current = true;
      try {
        const r = await raccoonPollLogin(sessionId, key);
        if (!active) return;
        if (r.status === 'success') {
          setPhase('done');
          onImported();
          void loadAccounts();
          // 登录后尽力领一次「桌面端登录奖励」（每号一次、幂等）。
          // 失败不影响登录成功 —— 与参考项目同策略。
          if (r.account?.id) {
            try {
              const w = await raccoonClaimReward(r.account.id, key);
              toast(
                w.result === 'claimed'
                  ? `已领取桌面端登录奖励 +${w.points ?? 0} 积分`
                  : w.result === 'already'
                    ? '该账号此前已领取过桌面端登录奖励'
                    : `登录奖励未领到：${w.message}`,
                w.result === 'claimed' ? 'ok' : 'warn',
              );
            } catch {
              toast('已登录；登录奖励可在下方单独领取', 'warn');
            }
          }
          return;
        }
        if (r.status === 'logging') {
          setPhase('scanned');
          return;
        }
        if (r.status === 'canceled') {
          // 上游取消了该 code：换一个新码，让二维码重新可用
          setPhase('idle');
          void startSession();
          return;
        }
        if (r.status === 'expired') {
          setError('登录会话已过期，请重新发起');
          setPhase('failed');
          return;
        }
        setPhase((p) => (p === 'scanned' ? 'scanned' : 'waiting'));
      } catch (e) {
        if (active) setError(e instanceof ApiError ? e.message : '轮询失败');
      } finally {
        polling.current = false;
      }
    }

    const timer = setInterval(() => { void tick(); }, Math.max(1000, pollIntervalMs));
    void tick();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, session, key, loadAccounts, onImported, startSession, toast]);

  /** 账号行内操作。 */
  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    await runAction({ label, fn, successMsg: ok, toast, onDone: loadAccounts });
  }

  async function removeAccount(a: RaccoonAccount) {
    setBusy(true);
    try {
      await raccoonDeleteAccount(a.id, key);
      toast('已删除该 Raccoon 账号', 'ok');
      await loadAccounts();
      onImported();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '删除失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  const remainingMs = session ? session.expiresAtMs - Date.now() : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入 Raccoon"
      desc="用微信扫码登录（本机无需安装客户端；凭据只写入本服务数据库）"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {(phase === 'failed' || phase === 'done') && (
            <Button variant="primary" onClick={startSession} disabled={busy}>
              {busy ? '处理中…' : '再登一个账号'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ---------- 扫码区 ---------- */}
        <div className="flex flex-col items-center gap-3">
          {phase === 'done' ? (
            <Note tone="neutral">
              登录成功，账号已入库并启用。可以继续「再登一个账号」，或用下方的账号操作查积分 / 领奖励。
            </Note>
          ) : phase === 'failed' ? (
            <Note tone="danger">{error || '扫码登录失败，请重试'}</Note>
          ) : !session ? (
            <LoadingBlock label="正在生成二维码" />
          ) : (
            <>
              {/* 二维码：后端产出的 path 属性，直接渲染，不出网、不注入 */}
              <svg
                viewBox={`0 0 ${session.qr.dim} ${session.qr.dim}`}
                width={200}
                height={200}
                shapeRendering="crispEdges"
                role="img"
                aria-label="Raccoon 登录二维码，请用微信扫一扫"
              >
                <rect width={session.qr.dim} height={session.qr.dim} fill="#ffffff" />
                <path d={session.qr.path} fill="#000000" />
              </svg>
              <div className="text-[12px] text-center" style={{ color: 'var(--rg-text-secondary)' }}>
                {phase === 'scanned'
                  ? '已扫码 —— 请在微信内确认授权，本页会自动进入下一步'
                  : '打开微信「扫一扫」，扫描上方二维码完成授权'}
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <Chip tone={phase === 'scanned' ? 'brand' : 'neutral'} dot={phase === 'scanned' ? 'dot-ok' : undefined}>
                  {phase === 'scanned' ? '等待微信确认' : '等待扫码'}
                </Chip>
                {remainingMs > 0 && (
                  <span className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                    二维码 {Math.ceil(remainingMs / 1000)} 秒后过期
                  </span>
                )}
                <Button size="sm" onClick={startSession} disabled={busy}>
                  刷新二维码
                </Button>
              </div>
              {error && <Note tone="warn">{error}</Note>}
              <Note>
                二维码内容含**一次性登录票据**，由本服务生成、不经任何第三方。
                把鼠标移到二维码上可以看到它承载的公开登录页地址（
                <a href={session.qrUrl} target="_blank" rel="noreferrer noopener">
                  在浏览器中打开
                </a>
                ）。
              </Note>
            </>
          )}
        </div>

        {/* ---------- 已登录账号 ---------- */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
            <span>已接入账号 {accounts?.length ?? 0} 个</span>
            {models && (
              <span style={{ color: 'var(--rg-text-tertiary)' }}>
                模型目录 {models.count} 个（{models.source === 'remote' ? '远端' : '兜底表，倍率可能不是最新'}）
              </span>
            )}
            <Button size="sm" onClick={loadAccounts}>
              刷新
            </Button>
          </div>

          {accounts && accounts.length > 0 && (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th cell-num">积分</th>
                  <th className="th">凭据到期</th>
                  <th className="th cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="row-hover">
                    <td className="td" data-label="账号">
                      <div className="font-mono text-[12px] truncate" title={a.label}>
                        {a.label || a.id}
                      </div>
                      <div className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {a.userId || a.id}
                        {a.raccoonOrg ? ` · ${a.raccoonOrg}` : ''}
                      </div>
                    </td>
                    <td className="td cell-num" data-label="积分">
                      {typeof a.points?.available === 'number' ? (
                        <span title={a.points.packages.map((p) => `${p.name} ${p.remaining}`).join('；') || undefined}>
                          {formatNumber(a.points.available)}
                        </span>
                      ) : typeof a.balance === 'number' ? (
                        formatNumber(a.balance)
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>未查询</span>
                      )}
                    </td>
                    <td className="td" data-label="凭据到期">
                      {a.expiredAt ? (
                        <span className="text-[12px]">{formatTime(a.expiredAt)}</span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td className="td cell-act">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            act('查积分', () => raccoonRefreshPoints(a.id, key), '积分已更新')
                          }
                        >
                          查积分
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            act('领登录奖励', () => raccoonClaimReward(a.id, key), '已处理登录奖励')
                          }
                        >
                          领登录奖励
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => act('续期', () => raccoonRefreshToken(a.id, key), '凭据已续期')}
                        >
                          续期
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => removeAccount(a)}>
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Note>
          <strong>每日 300 积分没有签到端点</strong>：它由服务端按日自动发放（账单里的
          <code>daily_grant</code>），所以这里（以及凭据池行内）都不会出现「签到」按钮——
          做一个必然失败的按钮不如不做。可领的只有一次性的<strong>桌面端登录奖励</strong>（每号一次）。
          <br />
          Raccoon 账号<strong>不参与 Trae 转发池</strong>：它的模型走独立端点
          <code>/v1/raccoon/chat/completions</code>，需要通用密钥（platform=all）。
        </Note>
      </div>
    </Modal>
  );
}
