import { useEffect, useState } from 'react';
import { getSetupStatus, createFirstLoginKey, type CreatedKey } from '../api/admin';
import { setKey } from '../stores/useAuth';
import { useToast } from './Toast';

interface Props {
  onReady: () => void;
}

/**
 * 首登引导：库内无登录密钥时，引导用户创建第一把登录密钥。
 * 创建成功后写入 localStorage 并进入应用。
 */
export default function SetupGate({ onReady }: Props) {
  const toast = useToast();
  const [phase, setPhase] = useState<'loading' | 'need' | 'ready' | 'creating'>('loading');
  const [label, setLabel] = useState('login');
  const [fresh, setFresh] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    getSetupStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.hasLoginKey) {
          setPhase('ready');
          onReady();
        } else {
          setPhase('need');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('ready');
          onReady();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  async function doCreate() {
    setPhase('creating');
    setErr('');
    try {
      const created = await createFirstLoginKey(label.trim() || 'login');
      setFresh(created);
      // 同时写入本地，创建后可直接管理
      setKey(created.key);
      toast('登录密钥已创建，请立即复制保存', 'ok');
    } catch (e) {
      setErr((e as Error).message);
      setPhase('need');
    }
  }

  async function copyKey() {
    if (!fresh) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(fresh.key);
      else throw new Error();
      setCopied(true);
      toast('已复制', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-ink-soft bg-bg">
        正在检查登录状态…
      </div>
    );
  }

  if (phase === 'ready') return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card shadow-pop w-[min(440px,100%)] p-6">
        {!fresh ? (
          <>
            <div className="flex items-center gap-2.5 mb-5">
              <div className="w-9 h-9 shrink-0 rounded-md bg-acc flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" aria-hidden="true">
                  <rect x="4.6" y="5.2" width="14.8" height="15.6" rx="2.5" stroke="#fff" strokeWidth="1.6" />
                  <path d="m8.5 13.4 2.4 2.4 4.6-4.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <div className="text-base font-semibold text-ink leading-tight">RelayGate</div>
                <div className="text-xs text-ink-soft">首次使用 · 创建登录密钥</div>
              </div>
            </div>
            <p className="text-[13px] text-ink-soft mb-5 leading-relaxed">
              登录密钥用于打开本管理面板。与「访问密钥」（供 IDE 调用转发接口）分离。
              创建后明文仅显示一次；若丢失可在服务器执行 <code className="font-mono text-xs">node scripts/login-key.js reset</code> 重置。
            </p>
            <label className="block text-xs font-medium text-ink-soft mb-2" htmlFor="login-label">
              备注（可选）
            </label>
            <input
              id="login-label"
              className="field w-full mb-4"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：本机面板"
              disabled={phase === 'creating'}
            />
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={phase === 'creating'}
              onClick={doCreate}
            >
              {phase === 'creating' ? '创建中…' : '创建登录密钥'}
            </button>
            {err && <div className="text-xs text-danger mt-3">{err}</div>}
          </>
        ) : (
          <>
            <h1 className="text-base font-semibold text-ink mb-1">登录密钥已生成</h1>
            <p className="text-[13px] text-ink-soft mb-4">
              请立即复制并妥善保存。关闭后无法再次查看完整明文。
            </p>
            <div className="rounded-md border border-line-hairline bg-surf-soft p-3 mb-3">
              <div className="font-mono text-[13px] break-all select-all text-ink">{fresh.key}</div>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary flex-1" onClick={copyKey}>
                {copied ? '已复制' : '复制密钥'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onReady}>
                进入面板
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
