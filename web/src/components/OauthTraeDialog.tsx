import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { oauthUrl, oauthStatus } from '../api/trae';
import type { Account as AcctType } from '../api/types';

interface OauthTraeDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: (a: AcctType) => void;
}

export default function OauthTraeDialog({ open, onClose, onDone }: OauthTraeDialogProps) {
  const { key } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [status, setStatus] = useState('尚未开始');
  // 一次性 state：由 /oauth/url 签发，提交回调时回传，服务端校验后作废
  const [state, setState] = useState('');
  const [running, setRunning] = useState(false);
  const timerRef = useRef<number | null>(null);

  function namePart() {
    const n = name.replace(/['";]/g, '').trim().slice(0, 60);
    return n ? `,name:'${n}'` : '';
  }

  function buildSnippet() {
    const relay = location.origin;
    const statePart = state ? `,state:'${state}'` : '';
    return (
      `(async()=>{const R='${relay}',C='en1oxy7wnw8j9n',A='https://api.trae.cn/cloudide/api/v3/trae';` +
      `const g=await fetch(A+'/oauth/GetRefreshToken',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientID:C})}).then(r=>r.json());` +
      `if(!g.Result)throw'未登录或无权限';` +
      `const rt=g.Result.RefreshToken;` +
      `const e=await fetch(A+'/oauth/ExchangeToken',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({ClientID:C,RefreshToken:rt,ClientSecret:'-',UserID:''})}).then(r=>r.json());` +
      `const d=await fetch(R+'/v1/credentials/oauth/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:e.Result.Token,refreshToken:e.Result.RefreshToken${namePart()}${statePart}})}).then(r=>r.json());` +
      `console.log('认证完成:',d.ok?'成功':JSON.stringify(d))})()`
    );
  }

  function stopTimer() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 卸载即停轮询：原先只经 handleClose 清理，父组件直接卸载时定时器会泄漏
  useEffect(() => stopTimer, []);

  function handleClose() {
    stopTimer();
    setRunning(false);
    onClose();
  }

  async function start() {
    if (running) return; // 流程进行中不再开第二个授权窗
    setRunning(true);
    setStatus('正在打开授权页…');
    try {
      const r = await oauthUrl(undefined, key);
      setState(r.state || '');
      setStatus('已打开授权页。完成第二步后，此处将自动提示认证结果。');
      // noopener：授权页不应通过 window.opener 反向操作本控制台
      window.open(r.url, '_blank', 'noopener,noreferrer');
      stopTimer();
      timerRef.current = window.setInterval(async () => {
        try {
          const st = await oauthStatus(key);
          if (st.result?.state === 'done') {
            stopTimer();
            setRunning(false);
            setStatus(`认证成功：${st.result.label || ''}`);
            toast(`账号已添加：${st.result.label || ''}`, 'ok');
            onDone({ id: '', label: st.result.label || '', enabled: true } as AcctType);
            window.setTimeout(handleClose, 1500);
          } else if (st.result?.state === 'error') {
            stopTimer();
            setRunning(false);
            setStatus(`认证失败：${st.result.message || '未知错误'}`);
          }
        } catch {
          /* 轮询失败静默重试 */
        }
      }, 2000);
    } catch (e) {
      setRunning(false);
      setStatus(`打开授权页失败：${(e as Error).message}`);
    }
  }

  async function copy() {
    const c = buildSnippet();
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(c);
      } else {
        throw new Error();
      }
      toast('代码已复制', 'ok');
    } catch {
      try {
        if (typeof document !== 'undefined') {
          const ta = document.createElement('textarea');
          ta.value = c;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          toast('代码已复制', 'ok');
        }
      } catch {
        toast('复制失败', 'err');
      }
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="OAuth 登录 Trae 账号"
      desc={
        <div className="space-y-1">
          <p>
            <b>第一步</b>：点击「打开授权页」并登录 Trae 账号。
          </p>
          <p>
            <b>第二步</b>：在授权页按 <b>F12</b> 打开控制台，粘贴以下代码并回车，认证将自动完成。
          </p>
        </div>
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={running}>
            {running ? '授权中…' : '打开授权页'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-ink-soft mb-2" htmlFor="oauth-name">
            账号名称（可选，默认自动命名）
          </label>
          <input id="oauth-name" className="field w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 solo-01" autoComplete="off" />
        </div>
        <div role="status" className="text-xs text-ink-soft">
          {status}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-ink-soft">认证代码</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
              复制代码
            </button>
          </div>
          <textarea
            id="oauth-snippet"
            className="field w-full font-mono text-[11px] resize-none"
            rows={3}
            readOnly
            value={buildSnippet()}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
          />
        </div>
      </div>
    </Modal>
  );
}