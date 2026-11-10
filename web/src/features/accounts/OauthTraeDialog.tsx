/**
 * Trae OAuth 登录弹窗。
 * 流程（对照 src/routes/credentials.js）：
 *   1. GET /oauth/url 取得授权地址与一次性 state；
 *   2. 打开授权页，用户在上游完成登录；
 *   3. 轮询 /oauth/status 判断结果；
 *   4. 若浏览器未自动回调，可粘贴回调 URL 走 /oauth/callback 解析。
 * state 一次性有效且与本次登录绑定，未先发起流程直接提交回调会被后端以
 * OAUTH_STATE_INVALID 拒绝。
 *
 * 关于「账号分组」——这里曾经是一个伪选项，2026-11-09 移除：
 *   原实现给了一个「默认池 / WorkBuddy 池」的二选一，并把它写进 `group` 字段。
 *   但真实的选池依据是**平台**（`credentials/pool.js#editionOk` 按 edition 分池：
 *   WorkBuddy 账号靠 edition='workbuddy' 进 WB 池，与 group 无关），
 *   而 `groupOk()` 只有在环境变量 `POOL_GROUPS` 非空时才过滤。
 *   于是「WorkBuddy 池」这个选项的效果是：给一个 **Trae** 账号打上
 *   group='workbuddy' 的标签，池子不动、调度不变——纯空操作，却让人以为
 *   自己把 Trae 账号送进了 WorkBuddy 转发池。本机 23 个账号的 group 实测全为
 *   null，`POOL_GROUPS` 也为空，进一步说明这个选项从未产生过任何效果。
 *
 *   现在改为：可自由填写分组名（与「调度属性」同一个字段、同一套语义），
 *   并说明「仅当启用分组筛选时才影响选号」。不再暗示它能切换平台池。
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { listGroups, oauthCallback, oauthStatus, oauthUrl, type OauthStatus } from '../../shared/api/credentials';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';
import { platformIdLabel } from '../../shared/lib/format';

type Phase = 'idle' | 'authorizing' | 'success' | 'error';

export function OauthTraeDialog({ open, onClose, onDone, presetLabel }: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** 从凭据行「重新登录」进入时的提示上下文 */
  presetLabel?: string;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<OauthStatus | null>(null);
  /** 账号分组：空 = 不分组。语义与「调度属性」里的分组完全一致。 */
  const [group, setGroup] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [busy, setBusy] = useState(false);
  /** 连续轮询失败计数：超过阈值时提示改用回调 URL，避免面板一直转圈 */
  const [pollFails, setPollFails] = useState(0);

  // 已有分组名作为候选：避免让用户凭记忆手打，也避免拼错导致分组对不上
  const groups = useAsyncData(
    (signal) => listGroups(key, signal),
    [key],
    { enabled: open && !!key },
  );
  const groupNames = (groups.data?.data ?? []).filter((g) => g.name != null);

  // 轮询句柄需在关闭时清理，避免后台持续请求
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function start() {
    setBusy(true);
    stopPolling();
    setPhase('authorizing');
    setStatus(null);
    try {
      const trimmed = group.trim();
      const r = await oauthUrl(trimmed === '' ? undefined : trimmed, key);
      // 授权在上游页面完成，本面板只负责发起与等待结果
      window.open(r.url, '_blank', 'noopener,noreferrer');
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const s = await oauthStatus(key);
            setPollFails(0);
            const cur = s.result ?? null;
            setStatus(cur);
            if (cur?.state === 'success') {
              stopPolling();
              setPhase('success');
              toast('OAuth 登录成功', 'ok');
              onDone();
            } else if (cur?.state === 'error') {
              stopPolling();
              setPhase('error');
            }
          } catch {
            // 轮询失败不中断流程，但要计数：连续失败时明确提示改用回调 URL，
            // 否则面板会停在「等待授权结果」而用户以为仍在正常等待
            setPollFails((n) => n + 1);
          }
        })();
      }, 2000);
    } catch (e) {
      setPhase('error');
      toast(e instanceof ApiError ? e.message : '获取授权地址失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function submitCallbackUrl() {
    if (!callbackUrl.trim()) {
      toast('请粘贴回调 URL', 'warn');
      return;
    }
    setBusy(true);
    try {
      const r = await oauthCallback(callbackUrl.trim(), key);
      if (r.ok) {
        setPhase('success');
        toast('已通过回调 URL 完成导入', 'ok');
        onDone();
        stopPolling();
      } else {
        setPhase('error');
        toast(`导入未成功：${r.detail?.message ?? '网关未返回失败原因，请稍后重试或改用粘贴回调 URL。'}`, 'err');
      }
    } catch (e) {
      setPhase('error');
      toast(e instanceof ApiError ? e.message : '回调解析失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        stopPolling();
        onClose();
      }}
      title="Trae OAuth 登录"
      desc={
        presetLabel
          ? `正在为「${presetLabel}」重新获取登录凭据`
          : '在上游页面完成授权，本面板仅负责发起流程与等待结果'
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              stopPolling();
              onClose();
            }}
          >
            关闭
          </Button>
          {phase === 'idle' && (
            <Button variant="primary" onClick={start} disabled={busy}>
              {busy ? '发起中…' : '开始登录'}
            </Button>
          )}
          {phase === 'success' && (
            <Button
              variant="primary"
              onClick={() => {
                stopPolling();
                onClose();
              }}
            >
              完成
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Field
          label="账号分组（可留空）"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="例如：trae-prod"
          list="trae-oauth-group-candidates"
        />
        <datalist id="trae-oauth-group-candidates">
          {groupNames.map((g) => (
            <option key={String(g.name)} value={String(g.name)} />
          ))}
        </datalist>
        <p className="mt-1.5 text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
          分组只是账号的标签，与「调度属性」里的分组是同一个字段。
          真正决定账号进哪个转发池的是<strong>平台本身</strong>：Trae 账号只进 Trae 池，
          {platformIdLabel('workbuddy')} 账号只进它自己的池，切换分组不会改变平台归属。
          仅当网关启用了分组筛选时，这个标签才会影响选号。
        </p>
      </div>

      {phase === 'idle' && (
        <Note>
          点击「开始登录」后会打开上游授权页。授权完成后本面板会自动感知，无需手动提交。
        </Note>
      )}

      {phase === 'authorizing' && (
        <div className="flex flex-col gap-3">
          <Note>
            等待授权结果…若授权页已关闭，可在下方粘贴回调 URL 手动完成。
          </Note>
          {pollFails >= 5 && (
            <Note tone="warn">
              已连续 {pollFails} 次无法查询授权状态（网络或网关无响应）。若已在授权页确认，
              请直接用下方的回调 URL 手动完成。
            </Note>
          )}
          <div>
            <div className="text-aux mb-1.5">回调 URL 手动导入</div>
            <textarea
                className="textarea h-24"
              placeholder="粘贴完整回调 URL"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              aria-label="OAuth 回调 URL"
            />
            <div className="mt-2">
              <Button size="sm" onClick={submitCallbackUrl} disabled={busy}>
                {busy ? '提交中…' : '解析并导入'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <Note>导入成功：{status?.result?.label ?? status?.label ?? '账号已加入凭据池'}。</Note>
      )}

      {phase === 'error' && (
        <Note tone="danger">{status?.message ?? '授权未完成，可重试，或粘贴回调 URL 手动导入。'}</Note>
      )}
    </Modal>
  );
}