/**
 * Trae OAuth 登录弹窗。
 *
 * 真实流程（对照 src/routes/credentials.js）：
 *   1. GET /oauth/url 取得授权地址与一次性 state；
 *   2. 打开授权页，用户在上游完成登录；
 *   3. 轮询 /oauth/status 判断结果；
 *   4. 若浏览器未自动回调，可粘贴回调 URL 走 /oauth/callback 兜底解析。
 *
 * 注意：state 一次性有效且与本次登录绑定，
 * 未先发起流程直接提交回调会被后端以 OAUTH_STATE_INVALID 拒绝。
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { oauthCallback, oauthStatus, oauthUrl, type OauthStatus } from '../../shared/api/credentials';
import { ApiError } from '../../shared/api/http';
import { Button, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

type Phase = 'idle' | 'authorizing' | 'success' | 'error';

export function OauthTraeDialog({ open, onClose, onDone }: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<OauthStatus | null>(null);
  const [group, setGroup] = useState<'default' | 'workbuddy'>('default');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [busy, setBusy] = useState(false);

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
      const r = await oauthUrl(group === 'default' ? undefined : group, key);
      // 授权在上游页面完成，本面板只负责发起与等待结果
      window.open(r.url, '_blank', 'noopener,noreferrer');
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const s = await oauthStatus(key);
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
            // 轮询失败不打断流程，等待下一次
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
        toast(`导入未成功：${r.detail?.message ?? '后端未给出原因'}`, 'err');
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
      desc="在上游页面完成授权，本面板仅负责发起流程与等待结果"
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
        <Segmented
          ariaLabel="账号分组"
          value={group}
          onChange={setGroup}
          options={[
            { value: 'default', label: '默认分组' },
            { value: 'workbuddy', label: 'WorkBuddy' },
          ]}
        />
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
          <div>
            <div className="text-aux mb-1.5">回调 URL 兜底</div>
            <textarea
              className="w-full h-24 p-2.5 rounded-md border font-mono text-[12px]"
              style={{ borderColor: 'var(--rg-border-stronger)' }}
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
        <Note tone="danger">{status?.message ?? '授权未完成，请重试或使用回调 URL 兜底。'}</Note>
      )}
    </Modal>
  );
}