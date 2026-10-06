import { useEffect, useState } from 'react';
import { createFirstLoginKey, getSetupStatus, listLoginKeys } from '../../shared/api/apiKeys';
import { setKey } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { useToast } from '../../shared/ui/Toast';
import { Button, Field } from '../../shared/ui';

interface Props {
  onReady: () => void;
}

/**
 * 首登引导。
 *
 * 两种进入方式，按后端 setup/status 的 hasLoginKey 自动选择默认项：
 *   输入已有密钥 —— 库中已存在登录密钥但手上没有明文时使用；
 *   创建首把密钥 —— 库中确实没有任何登录密钥时使用（后端仅允许本机来源调用）。
 */
export default function SetupGate({ onReady }: Props) {
  const toast = useToast();
  const [phase, setPhase] = useState<'loading' | 'gate' | 'ready' | 'creating'>('loading');
  /** 后端是否已存在登录密钥，决定默认展示哪个入口 */
  const [hasLoginKey, setHasLoginKey] = useState(false);
  const [label, setLabel] = useState('login');
  const [inputKey, setInputKey] = useState('');
  const [fresh, setFresh] = useState<{ id?: string; key: string; label?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSetupStatus()
      .then((s) => {
        if (cancelled) return;
        setHasLoginKey(s.hasLoginKey);
        // 已有登录密钥且本地有会话：直接放行，不必打扰用户
        if (s.hasLoginKey && sessionStorage.getItem('trae_key')) {
          setPhase('ready');
          onReady();
          return;
        }
        setPhase('gate');
      })
      .catch(() => {
        // 状态接口不可用时不阻塞：仍展示输入入口，由用户自行判断
        if (!cancelled) {
          setHasLoginKey(false);
          setPhase('gate');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  async function doVerify() {
    const candidate = inputKey.trim();
    if (!candidate) {
      setErr('请输入登录密钥');
      return;
    }
    setVerifying(true);
    setErr('');
    try {
      await listLoginKeys(candidate);
      setKey(candidate);
      toast('登录成功', 'ok');
      setPhase('ready');
      onReady();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? '密钥无效或已被重置' : (e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  async function doCreate() {
    setPhase('creating');
    setErr('');
    try {
      const created = await createFirstLoginKey(label.trim() || 'login');
      setFresh(created);
      setKey(created.key);
      toast('登录密钥已创建，请立即复制保存', 'ok');
    } catch (e) {
      setErr((e as Error).message);
      setPhase('gate');
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
      <div
        className="min-h-screen flex items-center justify-center text-[13px] bg-white"
        style={{ color: 'var(--rg-text-secondary)' }}
      >
        正在检查登录状态…
      </div>
    );
  }

  if (phase === 'ready') return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-white">
      <div className="panel w-[min(440px,100%)]">
        <div className="panel-body">
          <div className="flex items-center gap-2.5 mb-5">
            <div
              className="w-9 h-9 shrink-0 rounded-md flex items-center justify-center"
              style={{ background: 'var(--rg-brand-600)' }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" aria-hidden="true">
                <rect x="4.6" y="5.2" width="14.8" height="15.6" rx="2.5" stroke="#fff" strokeWidth="1.6" />
                <path
                  d="m8.5 13.4 2.4 2.4 4.6-4.8"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <div className="text-[16px] font-semibold leading-tight">RelayGate</div>
              <div className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
                管理面板 · {hasLoginKey ? '请输入登录密钥' : '首次使用'}
              </div>
            </div>
          </div>

          {!fresh && (
            <>
              {hasLoginKey ? (
                <>
                  <Field
                    label="登录密钥"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder="粘贴登录密钥"
                    aria-label="登录密钥"
                  />
                  <div className="h-4" />
                  <Button variant="primary" className="w-full" disabled={verifying} onClick={doVerify}>
                    {verifying ? '校验中…' : '进入面板'}
                  </Button>
                  <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--rg-border)' }}>
                    <p className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
                      没有现成密钥？服务器上执行
                    </p>
                    <code className="block mt-1 font-mono text-[11px]" style={{ color: 'var(--rg-text-primary)' }}>
                      node scripts/login-key.js reset
                    </code>
                    <p className="mt-2 text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                      重置会立即使旧密钥失效，需重新分发；该操作只能在服务器本机执行。
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[13px] mb-4 leading-relaxed" style={{ color: 'var(--rg-text-secondary)' }}>
                    库中尚未配置登录密钥，无法打开管理面板。
                    {hasLoginKey
                      ? '你也可以直接粘贴一把已有的登录密钥进入。'
                      : '请创建首把登录密钥，或粘贴一把已有的密钥。'}
                  </p>
                  <Field
                    label="已有登录密钥（可选）"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder="粘贴登录密钥"
                    aria-label="已有登录密钥"
                  />
                  <div className="h-3" />
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={verifying}
                    onClick={doVerify}
                  >
                    {verifying ? '校验中…' : '使用该密钥进入'}
                  </Button>
                  <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--rg-border)' }}>
                    <p className="text-[12px] mb-2" style={{ color: 'var(--rg-text-secondary)' }}>
                      确认没有任何密钥？创建一把新的
                    </p>
                    <Field
                      label="备注（可选）"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="例如：本机面板"
                      disabled={phase === 'creating'}
                    />
                    <div className="h-3" />
                    <Button
                      className="w-full"
                      disabled={phase === 'creating'}
                      onClick={doCreate}
                    >
                      {phase === 'creating' ? '创建中…' : '创建登录密钥'}
                    </Button>
                    <p className="mt-2 text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                      创建接口仅接受服务器本机来源的请求；创建后明文仅显示一次。
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          {fresh && (
            <>
              <h1 className="text-[16px] font-semibold mb-1">登录密钥已生成</h1>
              <p className="text-[13px] mb-4" style={{ color: 'var(--rg-text-secondary)' }}>
                请立即复制并妥善保存。关闭后无法再次查看完整明文。
              </p>
              <div
                className="rounded-md border p-3 mb-3"
                style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
              >
                <div className="font-mono text-[13px] break-all select-all">{fresh.key}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" className="flex-1" onClick={copyKey}>
                  {copied ? '已复制' : '复制密钥'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPhase('ready');
                    onReady();
                  }}
                >
                  进入面板
                </Button>
              </div>
            </>
          )}

          {err && (
            <div className="text-[12px] mt-3" style={{ color: 'var(--rg-state-error)' }} role="alert">
              {err}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}