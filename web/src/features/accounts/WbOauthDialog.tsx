/**
 * WorkBuddy 无感登录弹窗（免退出 OAuth，对标 WorkDaddy「登录新账号」）。
 *
 * 流程（对照 src/workbuddy/oauth.js 与 routes/workbuddy.js）：
 *   1. POST /v1/workbuddy/oauth/start：网关向 {billing}/v2/plugin/auth/state 取 state，
 *      返回系统浏览器授权地址；
 *   2. window.open 授权页（不动当前 WorkBuddy 客户端，也不退出任何账号）；
 *   3. 前端 2s 轮询 /oauth/poll；后端在 auth/token 拿到 accessToken 后拉
 *      login/account 并入库（新账号默认停用，与粘贴导入口径一致）；
 *   4. done=true 即完成；error 为一次性失败（超时/未返回 uid）。
 *
 * 与 Trae OAuth 弹窗的差异：WB 无本地回调监听器，无需粘贴回调 URL 兜底；
 * 轮询失败只计数提示，不中止流程（done=false 且 transient=true 继续等）。
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { patchAccount } from '../../shared/api/credentials';
import { wbOauthCancel, wbOauthPoll, wbOauthStart, type WbOauthPollResult } from '../../shared/api/workbuddy';
import { Button, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

type Phase = 'idle' | 'authorizing' | 'success' | 'error';
type Region = 'cn' | 'global';

export function WbOauthDialog({ open, onClose, onDone }: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [region, setRegion] = useState<Region>('cn');
  const [result, setResult] = useState<WbOauthPollResult | null>(null);
  /** 会话有效期（秒），来自 /oauth/start 的 expiresIn：告诉用户多久内必须完成授权 */
  const [expiresIn, setExpiresIn] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 连续轮询失败计数：超过阈值提示网络问题，但流程不中止 */
  const [pollFails, setPollFails] = useState(0);
  const loginIdRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);

  /**
   * 卸载清理：定时器随时停，登录会话按**卸载那一刻**的 ref 作废。
   * 不能在 effect 体内 `const id = loginIdRef.current`——挂载时 ref 必然为 null，
   * 闭包捕获后卸载时永远是 null，残留会话只能靠 900s TTL 自愈。
   */
  useEffect(() => {
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const id = loginIdRef.current;
      loginIdRef.current = null;
      if (id) void wbOauthCancel(id, key).catch(() => {});
    };
    // key 是稳定字符串；刻意不把 key 放进依赖——它变化时组件通常已随登录态重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setResult(null);
    setPollFails(0);
    try {
      const r = await wbOauthStart(region, key);
      loginIdRef.current = r.loginId;
      setExpiresIn(r.expiresIn);
      window.open(r.verificationUri, '_blank', 'noopener,noreferrer');
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const s = await wbOauthPoll(r.loginId, key);
            setPollFails(0);
            setResult(s);
            if (s.done) {
              stopPolling();
              if (s.result) {
                setPhase('success');
                onDone();
              } else {
                setPhase('error');
              }
            }
          } catch {
            // 轮询失败不中断流程；连续失败时提示网络问题
            setPollFails((n) => n + 1);
          }
        })();
      }, 2000);
    } catch (e) {
      setPhase('error');
      setResult({ object: '', done: true, error: e instanceof ApiError ? e.message : '发起登录失败' });
    } finally {
      setBusy(false);
    }
  }

  async function enableImported() {
    const id = result?.result?.id;
    if (!id) return;
    setBusy(true);
    try {
      await patchAccount(id, { enabled: true }, key);
      toast('账号已启用，可参与调度', 'ok');
      onDone();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '启用失败，可在凭据池重试', 'err');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    stopPolling();
    const id = loginIdRef.current;
    loginIdRef.current = null;
    if (id) void wbOauthCancel(id, key).catch(() => {});
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="WorkBuddy 无感登录"
      desc="不退出当前账号：在系统浏览器完成授权后，新账号自动加入凭据池"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            关闭
          </Button>
          {phase === 'idle' && (
            <Button variant="primary" onClick={start} disabled={busy}>
              {busy ? '发起中…' : '开始登录'}
            </Button>
          )}
          {phase === 'success' && (
            <Button variant="primary" onClick={enableImported} disabled={busy || !result?.result?.id}>
              {busy ? '处理中…' : '立即启用'}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Segmented
          ariaLabel="账号区域"
          value={region}
          onChange={(v) => setRegion(v as Region)}
          options={[
            { value: 'cn', label: '国内版' },
            { value: 'global', label: '国际版' },
          ]}
        />
      </div>

      {phase === 'idle' && (
        <Note>
          点击「开始登录」会在系统浏览器打开官方授权页。当前 WorkBuddy 客户端不受影响，
          已登录的账号不会被退出；授权完成后新账号自动入库（默认停用）。
        </Note>
      )}

      {phase === 'authorizing' && expiresIn > 0 && (
        <div className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
          授权链接 {Math.round(expiresIn / 60)} 分钟内有效；超时未完成请重新发起。
        </div>
      )}

      {phase === 'authorizing' && (
        <div className="flex flex-col gap-3">
          <Note>等待授权结果…在系统浏览器完成授权后面板会自动感知，无需手动提交。</Note>
          {pollFails >= 5 && (
            <Note tone="warn">
              已连续 {pollFails} 次无法查询授权状态（网络或网关无响应）。流程仍在继续；
              若授权页提示已完成但这里长时间无反应，请关闭后重试。
            </Note>
          )}
        </div>
      )}

      {phase === 'success' && result?.result && (
        <Note>
          导入成功：{result.result.nickname || result.result.uid}
          （{result.result.action === 'updated' ? '已更新既有账号' : '已新建账号'}，默认停用）。
        </Note>
      )}

      {phase === 'error' && (
        <Note tone="danger">{result?.error ?? '授权未完成，可重试。'}</Note>
      )}
    </Modal>
  );
}
