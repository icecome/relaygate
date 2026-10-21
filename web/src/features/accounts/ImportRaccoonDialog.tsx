/**
 * Raccoon 接入弹窗：面板承载扫码登录 / 本机客户端导入 + 已登录账号的运营操作。
 *
 * ## 两条登录入口
 *
 * 1. **扫码**（主入口，不依赖本机客户端）：官方那条 `office-raccoon://auth/callback`
 *    自定义协议回调**服务端进程收不到**，`/code/authorize` 的回调地址又写死，
 *    故由后端生成 code + 二维码（零依赖编码器，`<svg><path>` 直渲，不出网），
 *    用户微信扫码后前端轮询到 success。
 * 2. **读取本机客户端**（2026-10-15 解包后新增）：桌面端把凭据**明文**写在
 *    `~/.box-agent/config/auth.json`，可直接导入 —— 与 WorkBuddy/ZCode/Qoder 的
 *    本机导入同语义，但零解密成本。装了客户端的机器优先用这条，免扫码。
 *
 * ## 两条必须记住的语义
 *
 * 1. **每日 300 积分没有端点**（服务端按日自动发），本弹窗**不提供签到按钮**；
 *    能领的只有一次性的「桌面端登录奖励」，且它幂等（已领过返回 already）。
 *    但每日池**会过期**，故提供只读的「每日积分」查询（不触发任何写端点）。
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
  raccoonDailyUsage,
  raccoonDeleteAccount,
  raccoonKeepalive,
  raccoonKeepaliveAccount,
  raccoonLocalImport,
  raccoonLocalPreview,
  raccoonModels,
  raccoonPollLogin,
  raccoonRefreshPoints,
  raccoonRefreshToken,
  raccoonSetPasswordLogin,
  raccoonRunKeepalive,
  raccoonSaveKeepalive,
  raccoonStartLogin,
  type RaccoonAccount,
  type RaccoonDailyUsage,
  type RaccoonKeepalive,
  type RaccoonLocalPreview,
  type RaccoonLoginSession,
} from '../../shared/api/raccoon';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Button, Chip, LoadingBlock, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 扫码阶段的界面状态。 */
type Phase = 'idle' | 'waiting' | 'scanned' | 'done' | 'failed';

/**
 * 密码登录凭据配置表单（内嵌弹层）。
 *
 * 每日积分由**真实登录**触发发放，`login_with_password` 是网关侧唯一可编程复刻
 * 的真实登录入口。这里录手机号 + 密码，服务端会先实地验证登录成功再加密落库，
 * 失败不保存（避免每天用错密码白跑）。
 */
function PasswordLoginForm({
  busy,
  targetLabel,
  onCancel,
  onSave,
}: {
  busy: boolean;
  targetLabel: string;
  onCancel: () => void;
  onSave: (phone: string, password: string) => void;
}) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="rounded-lg border p-3 mt-3 flex flex-col gap-2"
      style={{ borderColor: 'var(--rg-border, #e5e7eb)' }}>
      <div className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
        为 <strong>{targetLabel}</strong> 配置密码登录（手机号 + 密码）。保存前网关会先试登录一次，
        成功才落库。密码在服务端加密存储、永不回显。留空点清除即删除凭据。
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <input
          className="rounded border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--rg-border, #e5e7eb)', background: 'transparent', color: 'inherit' }}
          placeholder="手机号（含国家码默认 86）"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={busy}
        />
        <input
          className="rounded border px-2 py-1 text-[12px]"
          style={{ borderColor: 'var(--rg-border, #e5e7eb)', background: 'transparent', color: 'inherit' }}
          placeholder="登录密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <Button size="sm" disabled={busy || !phone || !password} onClick={() => onSave(phone, password)}>
          保存
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onSave('', '')}>
          清除
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

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
  /** 本机客户端预检（装了客户端就有值；为 null 表示还没探测或没装） */
  const [localPreview, setLocalPreview] = useState<RaccoonLocalPreview | null>(null);
  /** 选中账号的每日积分看板（点「每日积分」时加载） */
  const [daily, setDaily] = useState<{ accountId: string; data: RaccoonDailyUsage } | null>(null);
  /** 保活任务快照（开关 + 上次结果 + 下次执行） */
  const [keepalive, setKeepalive] = useState<RaccoonKeepalive | null>(null);
  /** 密码登录凭据配置弹窗的目标账号 id */
  const [pwTarget, setPwTarget] = useState<string | null>(null);
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

  /** 探测本机客户端凭据（失败不影响弹窗其它部分）。 */
  const loadLocalPreview = useCallback(async () => {
    if (!key) return;
    try {
      setLocalPreview(await raccoonLocalPreview(key));
    } catch {
      setLocalPreview(null);
    }
  }, [key]);

  /** 从本机客户端凭据导入（幂等）。 */
  const importFromLocal = useCallback(async () => {
    setBusy(true);
    try {
      const r = await raccoonLocalImport(key);
      if ('error' in r && r.error) {
        toast(r.error.message, 'err');
      } else if ('account' in r && r.account) {
        toast(`已导入本机账号：${r.account.label || r.account.id}`, 'ok');
        await loadAccounts();
        onImported();
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '本机导入失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, loadAccounts, onImported, toast]);

  /** 查询每日积分（只读，不触发任何写端点）。 */
  const loadDaily = useCallback(async (accountId: string) => {
    setBusy(true);
    try {
      const r = await raccoonDailyUsage(accountId, key);
      setDaily({ accountId, data: r });
    } catch (e) {
      setDaily(null);
      toast(e instanceof ApiError ? e.message : '每日积分查询失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, toast]);

  /** 拉保活任务快照。 */
  const loadKeepalive = useCallback(async () => {
    if (!key) return;
    try {
      setKeepalive(await raccoonKeepalive(key));
    } catch {
      setKeepalive(null);
    }
  }, [key]);

  /** 开关保活（写配置并立即重排定时器）。 */
  const toggleKeepalive = useCallback(async (enabled: boolean) => {
    if (!key) return;
    setBusy(true);
    try {
      setKeepalive(await raccoonSaveKeepalive({ enabled }, key));
      toast(
        // 文案必须与后端订正后的语义一致：每日积分由上游在**真实客户端登录**时
        // 发放，网关代打无法触发发放；保活的真实作用是「对有密码的账号代做一次
        // 真实登录并如实上报当日有效期」。写成「已帮你延长到 7 天」是在承诺做不到的事。
        enabled
          ? '已开启每日保活：每天对有密码的账号代做一次真实登录，并如实上报当日有效期'
          : '已关闭每日保活：当天未登录桌面端时，300 分将在 24:00 清零',
        enabled ? 'ok' : 'warn',
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保活配置保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, toast]);

  /** 立即跑一轮保活（全账号，含自校验）。 */
  const runKeepaliveNow = useCallback(async () => {
    if (!key) return;
    setBusy(true);
    try {
      const r = await raccoonRunKeepalive(key);
      // 上游未发放今日每日积分不是「失败」，是**无可延长对象**（上游状态，网关无法干预）。
      const upstreamSkipped = (r as unknown as { upstreamSkipped?: number }).upstreamSkipped ?? 0;
      if (r.ok || r.notExtended || r.failed) {
        toast(
          r.ok && !r.notExtended && !r.failed
            ? `保活完成：${r.ok}/${r.total} 个账号当日积分已延长`
            : `保活未全部生效：延长 ${r.ok}，未延长 ${r.notExtended}，失败 ${r.failed}`
              + (upstreamSkipped ? `，上游未发放 ${upstreamSkipped}` : ''),
          r.ok && !r.notExtended && !r.failed ? 'ok' : 'warn',
        );
      } else if (upstreamSkipped) {
        toast(
          `保活已执行：${upstreamSkipped} 个账号今日每日积分由上游发放（网关代打不触发发放），本次无可延长对象`,
          'warn',
        );
      } else {
        toast('保活完成：无有效账号', 'ok');
      }
      await loadKeepalive();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保活执行失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, loadKeepalive, toast]);

  /** 单账号保活（行内按钮）。 */
  const keepaliveOne = useCallback(async (accountId: string) => {
    setBusy(true);
    try {
      const r = await raccoonKeepaliveAccount(accountId, key);
      toast(r.message, r.ok ? 'ok' : 'warn');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保活失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, toast]);

  /**
   * 保存密码登录凭据（服务端会先实地验证登录成功才落库）。
   * phone/password 为空 = 清除。
   */
  const savePasswordLogin = useCallback(async (accountId: string, phone: string, password: string) => {
    setBusy(true);
    try {
      const r = await raccoonSetPasswordLogin(accountId, { phone, password }, key);
      toast(r.configured ? '已配置密码登录：每日保活将代做真实登录以触发发放' : '已清除密码登录凭据', 'ok');
      setPwTarget(null);
      await loadAccounts();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '配置失败', 'err');
    } finally {
      setBusy(false);
    }
  }, [key, loadAccounts, toast]);

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

  // 打开时：探测账号与本机客户端、拉模型目录与保活状态，并发起扫码会话；关闭时：取消会话
  useEffect(() => {
    if (open) {
      void loadAccounts();
      void loadLocalPreview();
      void loadKeepalive();
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
      setDaily(null);
    }
    // key 变化（重新登录面板）时也要重来
  }, [open, key, loadAccounts, loadLocalPreview, loadKeepalive, startSession]);

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
        {/* ---------- 本机客户端导入（装了客户端时优先，免扫码） ---------- */}
        {localPreview?.installed && (
          <div className="flex items-center gap-2 flex-wrap rounded-lg p-3"
            style={{ background: 'var(--rg-bg-soft, #f7f7f7)' }}>
            <Chip tone="brand" dot="dot-ok">检测到本机小浣熊客户端</Chip>
            <span className="text-[12px] flex-1 min-w-[240px]"
              style={{ color: 'var(--rg-text-secondary)' }}>
              可直接从本机登录态导入，无需扫码。凭据文件：<code>{localPreview.credentialFile}</code>
              {localPreview.account?.expiresAt
                ? `（有效期至 ${formatTime(localPreview.account.expiresAt)}）`
                : ''}
            </span>
            <Button size="sm" variant="primary" disabled={busy} onClick={importFromLocal}>
              从本机导入
            </Button>
          </div>
        )}
        {localPreview && !localPreview.installed && localPreview.error && (
          <Note tone="warn">本机客户端读取失败：{localPreview.error}</Note>
        )}

        {/* ---------- 每日保活（当日登录 → 300 分有效期延长到 7 天） ---------- */}
        {keepalive && (
          <div className="flex flex-col gap-2 rounded-lg p-3"
            style={{ background: 'var(--rg-bg-soft, #f7f7f7)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <strong className="text-[13px]">每日积分保活</strong>
              <Chip tone={keepalive.enabled ? 'ok' : 'neutral'} dot={keepalive.enabled ? 'dot-ok' : undefined}>
                {keepalive.enabled ? '已开启' : '未开启'}
              </Chip>
              {keepalive.enabled && keepalive.nextRunAt && (
                <span className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  下次 {formatTime(keepalive.nextRunAt)}
                </span>
              )}
              <div className="flex-1" />
              <Button size="sm" disabled={busy} onClick={() => toggleKeepalive(!keepalive.enabled)}>
                {keepalive.enabled ? '关闭' : '开启'}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={runKeepaliveNow}>
                立即保活
              </Button>
            </div>
            <div className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
              上游规则：每日 300 分默认<strong>当天 24:00 清零</strong>，当天登录后有效期延长至
              <strong> 7 天</strong>。
              <br />
              <strong>注意</strong>：每日积分由上游在<strong>真实客户端登录</strong>时发放，
              网关代打无法触发发放（2026-10-19/20 实证）。开启后网关对<strong>已配置密码</strong>
              的账号每天代做一次真实登录（这是唯一可编程复刻的发放载体），并读取当日账单
              <strong>如实上报</strong>有效期；未配置密码的账号只观测、不伪造成功。
              若某日上游未产生当日账单，会显示「上游未发放」而非失败 —— 这是上游状态，非网关故障。
            </div>
            {keepalive.lastSummary && (
              <div className="text-[11px] flex gap-3 flex-wrap" style={{ color: 'var(--rg-text-tertiary)' }}>
                <span>
                  上次（{formatTime(keepalive.lastSummary.ranAt)}）：
                  延长 {keepalive.lastSummary.ok} / 未延长 {keepalive.lastSummary.notExtended} / 失败 {keepalive.lastSummary.failed}
                  {keepalive.lastSummary.upstreamSkipped ? ` / 上游未发放 ${keepalive.lastSummary.upstreamSkipped}` : ''}
                  （共 {keepalive.lastSummary.total}）
                </span>
              </div>
            )}
          </div>
        )}

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
                          onClick={() => loadDaily(a.id)}
                        >
                          每日积分
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          title="代打一次「当日登录」，读取当日账单如实上报（幂等）"
                          onClick={() => keepaliveOne(a.id)}
                        >
                          保活
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          title="配置手机号 + 密码，让网关每天代做真实登录来触发每日发放。"
                          onClick={() => setPwTarget(a.id)}
                        >
                          {a.hasPasswordLogin ? '重设密码' : '配置密码'}
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

        {/* ---------- 每日积分看板（只读） ---------- */}
        {daily && daily.data && (
          <div className="rounded-lg p-3 text-[12px] flex flex-col gap-1"
            style={{ background: 'var(--rg-bg-soft, #f7f7f7)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <strong>每日积分（{accounts?.find((a) => a.id === daily.accountId)?.label || daily.accountId}）</strong>
              {!daily.data.billsAvailable && (
                <Chip tone="warn">账单面不可用，以下可能不完整</Chip>
              )}
              {daily.data.balanceAvailable === false && (
                <Chip tone="warn">余额面不可用</Chip>
              )}
            </div>
            <div className="flex gap-4 flex-wrap" style={{ color: 'var(--rg-text-secondary)' }}>
              <span>
                今日剩余
                <strong className="mx-1">
                  {typeof daily.data.dailyRemaining === 'number' ? formatNumber(daily.data.dailyRemaining) : '—'}
                </strong>
                （每日期初 {daily.data.grantPoints}）
              </span>
              {daily.data.nextExpiryAt && (
                <span>
                  最早
                  <strong className="mx-1">{daily.data.nextExpiryHoursLeft} 小时后</strong>
                  作废（{formatTime(daily.data.nextExpiryAt)}）
                </span>
              )}
              <span>
                历史已作废
                <strong className="mx-1">{formatNumber(daily.data.expiredTotal)}</strong>
              </span>
            </div>
            <div style={{ color: 'var(--rg-text-tertiary)' }}>
              每日 {daily.data.grantPoints} 分由服务端自动发放（无领取端点），约 7 天内未用完即清零。
              想少浪费就把它排进消耗计划，而不是等一个不存在的签到按钮。
            </div>
          </div>
        )}

        <Note>
          <strong>每日 300 积分没有签到端点</strong>：它由服务端按日自动发放（账单里的
          <code>daily_grant</code>），所以这里（以及凭据池行内）都不会出现「签到」按钮——
          做一个必然失败的按钮不如不做。可领的只有一次性的<strong>桌面端登录奖励</strong>（每号一次）。
          <br />
          Raccoon 账号<strong>不参与 Trae 转发池</strong>：它的模型走独立端点
          <code>/v1/raccoon/chat/completions</code>，需要通用密钥（platform=all）。
        </Note>
      </div>

      {/* 密码登录凭据配置弹窗 */}
      {pwTarget && (
        <PasswordLoginForm
          busy={busy}
          targetLabel={accounts?.find((a) => a.id === pwTarget)?.label || pwTarget}
          onCancel={() => setPwTarget(null)}
          onSave={(phone, password) => savePasswordLogin(pwTarget, phone, password)}
        />
      )}
    </Modal>
  );
}
