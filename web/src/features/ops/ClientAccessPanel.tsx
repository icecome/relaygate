/**
 * 客户端接入面板。
 *
 * 数据来自 /v1/admin/client-config —— 后端已按当前请求 Host 生成好三种协议的
 * 环境变量与 curl 示例，并附部署注意事项。此处只做展示与复制，
 * 不在前端拼接 URL，避免与后端生成逻辑不一致。
 */
import { useState } from 'react';
import type { ClientConfig } from '../../shared/api/admin';
import { Button, ErrorState, LoadingBlock, Note, Panel, Segmented } from '../../shared/ui';
import { useToast } from '../../shared/ui/Toast';

type Proto = 'openai' | 'anthropic' | 'codex';

export function ClientAccessPanel({
  config,
  loading,
  error,
  onRetry,
}: {
  config: ClientConfig | null | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const toast = useToast();
  const [proto, setProto] = useState<Proto>('openai');

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`, 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  }

  /** 统一渲染「键 → 值」并带复制按钮。 */
  function Entry({ k, v }: { k: string; v: string | undefined }) {
    if (!v) return null;
    return (
      <div className="flex items-start gap-2 py-1.5">
        <span className="font-mono text-[12px] w-[190px] shrink-0" style={{ color: 'var(--rg-text-secondary)' }}>
          {k}
        </span>
        <span className="font-mono text-[12px] flex-1 break-all">{v}</span>
        <Button size="sm" variant="ghost" onClick={() => copy(v, k)}>
          复制
        </Button>
      </div>
    );
  }

  function Block({ title, text }: { title: string; text: string | undefined }) {
    if (!text) return null;
    return (
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="t-label">{title}</span>
          <Button size="sm" variant="ghost" onClick={() => copy(text, title)}>
            复制
          </Button>
        </div>
        <pre
          className="rounded-md border p-3 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-all"
          style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
        >
          {text}
        </pre>
      </div>
    );
  }

  return (
    <Panel
      title="客户端接入"
      description="把 IDE 或脚本指向本服务，使用访问密钥调用"
      footer="转发面使用访问密钥（sk-…）；管理面板使用登录密钥（sk-admin-…），两者不可混用。"
    >
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading || !config ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="mb-3">
            <Segmented
              ariaLabel="协议"
              value={proto}
              onChange={setProto}
              options={[
                { value: 'openai', label: 'OpenAI 兼容' },
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'codex', label: 'Codex Responses' },
              ]}
            />
          </div>

          <div className="text-[12px] mb-2" style={{ color: 'var(--rg-text-tertiary)' }}>
            服务地址
          </div>
          <Entry k="BASE_URL" v={config.baseUrl} />

          {proto === 'openai' && (
            <>
              <div className="text-[12px] mt-4 mb-2" style={{ color: 'var(--rg-text-tertiary)' }}>
                环境变量
              </div>
              <Entry k="OPENAI_BASE_URL" v={config.openai?.OPENAI_BASE_URL} />
              <Entry k="OPENAI_API_KEY" v={config.openai?.OPENAI_API_KEY} />
              <Block title="curl 示例" text={config.openai?.curl} />
            </>
          )}

          {proto === 'anthropic' && (
            <>
              <div className="text-[12px] mt-4 mb-2" style={{ color: 'var(--rg-text-tertiary)' }}>
                环境变量
              </div>
              <Entry k="ANTHROPIC_BASE_URL" v={config.anthropic?.ANTHROPIC_BASE_URL} />
              <Entry k="ANTHROPIC_API_KEY" v={config.anthropic?.ANTHROPIC_API_KEY} />
              <Block title="curl 示例" text={config.anthropic?.curl} />
            </>
          )}

          {proto === 'codex' && (
            <>
              <div className="text-[12px] mt-4 mb-2" style={{ color: 'var(--rg-text-tertiary)' }}>
                环境变量
              </div>
              <Entry k="base_url" v={config.codex?.base_url} />
              {config.codex?.note && (
                <div className="mt-3">
                  <Note>{config.codex.note}</Note>
                </div>
              )}
            </>
          )}

          {(config.notes?.length ?? 0) > 0 && (
            <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--rg-border)' }}>
              <div className="t-label mb-2">接入注意</div>
              <ul className="flex flex-col gap-1.5">
                {config.notes?.map((n, i) => (
                  <li
                    key={i}
                    className="text-[12px] flex gap-2"
                    style={{ color: 'var(--rg-text-secondary)' }}
                  >
                    <span style={{ color: 'var(--rg-text-tertiary)' }}>·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}