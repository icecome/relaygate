/**
 * 上游 Provider 新增 / 编辑弹窗。
 *
 * ## 为什么需要这个弹窗
 *
 * 后端 `PUT /v1/admin/model-router/providers/:id` 一直存在
 * （`src/routes/model-router.js:27`），但面板只给了「删除」——
 * `ModelRouterPage` 的空态甚至写着「第三方需在配置里新增 provider 条目后重载」，
 * 等于把用户推去手改 `model-router.json`。这是「无法添加外部模型 API」的
 * 唯一成因，纯前端缺口。
 *
 * ## 密钥为什么是「环境变量名」而不是密钥串
 *
 * `store.normalizeProvider`（`src/model-router/store.js:100-110`）会把明文
 * `apiKey` 一律剥离，只留 `apiKeyEnv`；运行时由
 * `dispatch.resolveApiKey` 读 `process.env[apiKeyEnv]`。这是 M-S6 的修复结果：
 * 此前明文密钥被原样持久化到 model-router.json，与账号 token 的
 * AES-256-GCM 口径不一致。
 *
 * 因此本表单只能提交变量名。三种常见误用及其确切症状：
 *
 * | 用户做了什么 | 面板表现 | 请求表现 |
 * |---|---|---|
 * | 在 apiKeyEnv 里贴了 `sk-...` | 保存成功 | `provider 缺少 API Key（apiKeyEnv=sk-...）` 401 |
 * | 写了变量名但没写进 .env | 保存成功，判定「已配置」 | 同上 401 |
 * | 写进 .env 但没重启进程 | 保存成功 | 同上 401（`process.env` 在启动时快照） |
 *
 * 三种都必须在界面上讲清楚，否则用户会认为面板坏了。所以：
 *   - 字段下方常驻提示「值写在 .env，保存后需重启进程」；
 *   - `hasApiKey` 只代表「填了变量名」，列表里的措辞是「已声明」而不是「可用」；
 *   - 真正的可用性判定留给一次真实请求（模型池页「探测」）。
 *
 * ## 内置 Provider 为什么锁住字段
 *
 * `normalizeProvider` 对 `type==='builtin'` 会把 `baseUrl` 置 null、
 * `models` 置 null，`builtin` 只认白名单 `trae|workbuddy|raccoon`（不在名单里
 * 会被静默归一成 `trae` —— 那是一次真实事故：Raccoon 曾因漏在名单外，
 * 候选里显示 sn-* 模型而请求打到 Trae 上游拿 4001）。
 * 所以内置行只能改 `label` 与 `enabled`，其余字段在弹窗里禁用，避免
 * 「改完看着生效、实际被归一掉」。
 */
import { useEffect, useMemo, useState } from 'react';
import { upsertProvider, type RouterProvider } from '../../shared/api/modelRouter';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 表单草稿。`models` 用逗号分隔的字符串，提交时再切分成数组。 */
interface Draft {
  id: string;
  label: string;
  type: 'openai' | 'builtin';
  builtin: 'trae' | 'workbuddy' | 'raccoon' | null;
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  models: string;
  timeoutMs: string;
}

const EMPTY: Draft = {
  id: '',
  label: '',
  type: 'openai',
  builtin: null,
  enabled: true,
  baseUrl: 'https://',
  apiKeyEnv: '',
  models: '',
  timeoutMs: '600000',
};

/** 后端默认超时（store.normalizeProvider 的 600000）。占位与空值都按它落。 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** provider id 会进路径段与 JSON 键，限成可读字符集避免编码歧义。 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

function toDraft(p: RouterProvider): Draft {
  return {
    id: p.id,
    label: p.label || p.id,
    type: p.type,
    builtin: (p.builtin as Draft['builtin']) ?? null,
    enabled: p.enabled !== false,
    baseUrl: p.baseUrl || '',
    apiKeyEnv: p.apiKeyEnv || '',
    models: Array.isArray(p.models) ? p.models.join(', ') : '',
    timeoutMs: String(p.timeoutMs || DEFAULT_TIMEOUT_MS),
  };
}

export function ProviderDialog({
  open,
  /** null = 新建；传入 = 编辑该 Provider */
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider: RouterProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const editing = provider != null;
  const isBuiltin = editing && provider.type === 'builtin';

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // 打开时按当前行回填（编辑）或重置（新建）。依赖 open 而非 provider，
  // 因为同一行连点两次「编辑」不应把用户已改的草稿冲掉。
  useEffect(() => {
    if (!open) return;
    setFieldError(null);
    setDraft(provider ? toDraft(provider) : { ...EMPTY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const modelsList = useMemo(
    () =>
      draft.models
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [draft.models],
  );

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setFieldError(null);
  }

  /** 提交前的本地校验：只挡「后端一定 400」的形态错误，语义错误交给后端原样回传。 */
  function validate(): string | null {
    const id = draft.id.trim();
    if (!id) return '请填写 Provider ID';
    if (!ID_RE.test(id)) return 'Provider ID 只能用字母、数字、点、下划线、短横线，且以字母或数字开头（最长 48 字符）';
    if (draft.type === 'openai') {
      const url = draft.baseUrl.trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return 'Base URL 必须是 http(s) 地址，例如 https://api.example.com/v1';
      if (!draft.apiKeyEnv.trim()) return '请填写 API Key 的环境变量名（值写在 .env，不在面板里填密钥）';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.apiKeyEnv.trim())) {
        return '环境变量名只能用字母、数字、下划线，且不能以数字开头';
      }
    }
    const t = Number(draft.timeoutMs);
    if (draft.timeoutMs.trim() && (!Number.isFinite(t) || t <= 0)) return '超时必须是正整数毫秒数';
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) {
      setFieldError(err);
      return;
    }
    const id = draft.id.trim();
    // 内置 Provider 的后端归一语义（store.normalizeProvider）：
    //   builtin: 只认白名单，baseUrl / apiKeyEnv / models 一律置 null，
    //   type 固定 'builtin'。所以这里只提交真正会生效的三个字段。
    const body: Partial<RouterProvider> = isBuiltin
      ? { label: draft.label.trim() || id, enabled: draft.enabled }
      : {
          type: 'openai',
          label: draft.label.trim() || id,
          enabled: draft.enabled,
          baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
          apiKeyEnv: draft.apiKeyEnv.trim(),
          // 空 = 全部模型（后端 normalizeProvider 把 '' 归成 null）
          models: modelsList.length ? modelsList : null,
          timeoutMs: Number(draft.timeoutMs) || DEFAULT_TIMEOUT_MS,
        };

    setBusy(true);
    try {
      await upsertProvider(id, body, key);
      toast(
        isBuiltin
          ? `已保存 Provider ${id}（内置只支持改名称与启用状态）`
          : `已保存 Provider ${id}。若刚新增或改了变量名，需把 ${draft.apiKeyEnv.trim()} 写进 .env 并重启进程才会生效`,
        'ok',
      );
      onSaved();
      onClose();
    } catch (e) {
      // 后端 400 的 message 是英文但精确（id is required / baseUrl 必须是 http(s) URL）。
      // 不翻译：用户拿这句去 grep 源码能直接命中校验点。
      setFieldError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑 Provider：${provider.id}` : '新增上游 Provider'}
      desc={
        editing
          ? '内置 Provider 只改名称与启用状态；第三方端点可改 Base URL、密钥变量名与模型范围'
          : '接入一个 OpenAI 兼容端点，让它成为虚拟模型的候选来源'
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid gap-3 grid-cols-2">
          <Field
            label="Provider ID（保存后不可改，候选靠它引用）"
            value={draft.id}
            disabled={editing}
            placeholder="my-deepseek"
            onChange={(e) => patch({ id: e.target.value.trim() })}
          />
          <Field
            label="显示名称"
            value={draft.label}
            placeholder="DeepSeek 官方"
            onChange={(e) => patch({ label: e.target.value })}
          />
        </div>

        {!editing && (
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
              类型
            </span>
            <select
              className="field w-full"
              aria-label="Provider 类型"
              value={draft.type}
              onChange={(e) => patch({ type: e.target.value === 'builtin' ? 'builtin' : 'openai' })}
            >
              <option value="openai">第三方 OpenAI 兼容端点</option>
              <option value="builtin">内置账号池（trae / workbuddy / raccoon）</option>
            </select>
            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
              内置类型只登记已有账号池的别名；日常接入外部模型 API 请选第一项。
            </span>
          </div>
        )}

        {draft.type === 'builtin' ? (
          <Note>
            内置 Provider 的 candidates 由凭据池账号执行，不需要 Base URL 与密钥。
            可改的只有显示名称与启用状态；<code className="font-mono">builtin</code>{' '}
            字段只认 trae / workbuddy / raccoon，写错会被后端静默归一成 trae。
          </Note>
        ) : (
          <>
            <Field
              label="Base URL"
              value={draft.baseUrl}
              disabled={isBuiltin}
              placeholder="https://api.example.com/v1"
              onChange={(e) => patch({ baseUrl: e.target.value.trim() })}
            />
            <div className="flex flex-col gap-1 min-w-0">
              <Field
                label="API Key 环境变量名（不是密钥本身）"
                value={draft.apiKeyEnv}
                disabled={isBuiltin}
                placeholder="MY_PROVIDER_API_KEY"
                className="font-mono"
                onChange={(e) => patch({ apiKeyEnv: e.target.value.trim() })}
              />
              <span className="text-aux leading-[1.6]" style={{ color: 'var(--rg-state-warning)' }}>
                密钥值写在项目根 .env：<code className="font-mono">{draft.apiKeyEnv.trim() || 'MY_PROVIDER_API_KEY'}=sk-…</code>
                ，保存后需重启进程。面板不存密钥——后端会剥离明文，只按变量名在运行时取。
              </span>
            </div>

            <div className="grid gap-3 grid-cols-2">
              <Field
                label="模型清单（逗号分隔，留空 = 全部）"
                value={draft.models}
                disabled={isBuiltin}
                placeholder="deepseek-chat, deepseek-reasoner"
                onChange={(e) => patch({ models: e.target.value })}
              />
              <Field
                label="超时（毫秒）"
                type="number"
                inputMode="numeric"
                value={draft.timeoutMs}
                disabled={isBuiltin}
                onChange={(e) => patch({ timeoutMs: e.target.value })}
              />
            </div>

            {modelsList.length > 0 && (
              <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                将登记 {modelsList.length} 个模型：{modelsList.slice(0, 6).join('、')}
                {modelsList.length > 6 ? ` 等 ${modelsList.length} 个` : ''}。新增虚拟模型时，
                下拉里能直接选到这些名字。
              </span>
            )}
          </>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span style={{ color: 'var(--rg-text-primary)' }}>启用这个 Provider</span>
          <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
            停用后引用它的候选会被标记为不可用，但不会被删除
          </span>
        </label>

        {fieldError && (
          <Note tone="danger">
            <span className="break-all">{fieldError}</span>
          </Note>
        )}

        <Note>
          保存后不会自动重载路由：需要回到页面点「重载路由」，或调用
          <code className="font-mono"> POST /v1/admin/model-router/reload</code>。
          新增 Provider 后还要建一个虚拟模型把对外模型名映射过去，客户端才能调到它。
        </Note>
      </div>
    </Modal>
  );
}
