/**
 * 访问密钥创建弹窗。
 *
 * ## 为什么需要独立的对话框（而不是复用 usePrompt）
 *
 * 此前创建访问密钥走的是 `prompt({ input: { label: '备注' } })`，而 `prompt`
 * 只支持**一个文本输入框**，于是 `platform` 被硬编码成 `'all'`
 * （`AccessKeysPage.tsx` 旧代码：`{ label: ..., platform: 'all' }`），
 * 用户无法创建 Trae / WorkBuddy 专用密钥 —— 而那正是平台隔离的基础：
 *
 *   - `trae` 密钥只能调 Trae 模型（`model:trae/*`），越界会被
 *     `middleware/model-access.js` 拒成 403；
 *   - `workbuddy` 密钥同理；
 *   - `all` 是通用密钥，可调全部平台（含 Raccoon / Qoder 这些「只有通用密钥
 *     能碰」的独立池）。
 *
 * 所以「只能建 all」不只是少一个选项：它让用户**无法把密钥权限收窄**，
 * 手里每把钥匙都是全能钥匙。这既不利于分工（给 IDE 一把、给脚本一把），
 * 也让「密钥泄露的影响面」无法控制。
 *
 * ## 平台选择的两个约束（照抄后端语义，不要在前端另立一套）
 *
 * 1. **PLATFORMS 固定三值**：`trae | workbuddy | all`。后端
 *    `credentials/api-keys.js#PLATFORMS` 是唯一事实源；这里若多出第四个值，
 *    创建会拿到 400 `platform is required (trae|workbuddy|all)`。
 * 2. **platform 决定默认 scopes/resources**（后端 `DEFAULT_SCOPES` /
 *    `DEFAULT_RESOURCES`）。弹窗**不暴露**这两个字段 —— 让用户手填资源路径
 *    是错的方向：填错的表现是「密钥建出来了但调什么都 403」，而错误原因
 *    完全不指向那行配置。默认值已经是对的，需要收窄时应在密钥详情里改。
 *
 * ## 密钥类型
 *
 * `keyType` 也在后端有语义（`universal | dedicated`），但它**不影响鉴权**，
 * 只是标注用途。这里一并暴露，因为「通用 / 专用」这个说法在平台选择旁边
 * 更好理解 —— 选了 `trae` 平台再标成「通用」会自相矛盾，反之亦然。
 * 但它不是必填，缺省由后端决定。
 */
import { useEffect, useRef, useState } from 'react';
import { createAccessKey, type CreatedKey } from '../../shared/api/apiKeys';
import { getKey } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/**
 * 可选的密钥平台。
 *
 * ⚠️ 必须与后端 `credentials/api-keys.js#PLATFORMS` 逐字一致。
 * 不一致的后果是「前端能选、后端 400」，而 400 的文案还会把用户引向
 * 后端那两个值（`trae|workbuddy|all`）—— 看起来像前端给了错选项。
 */
const PLATFORM_OPTIONS = [
  {
    value: 'all',
    label: '通用（全部模型）',
    hint: '可调用 Trae / WorkBuddy 以及 Raccoon、Qoder 等独立池。资源范围为 *。',
  },
  {
    value: 'trae',
    label: 'Trae 平台',
    hint: '只能调用 Trae 系模型。用它调 WorkBuddy / Raccoon / Qoder 模型会被 403。',
  },
  {
    value: 'workbuddy',
    label: 'WorkBuddy 平台',
    hint: '只能调用 WorkBuddy 模型（含目录里 Trae 不服务的那些）。',
  },
] as const;

type PlatformValue = (typeof PLATFORM_OPTIONS)[number]['value'];

export function CreateAccessKeyDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（父组件用它展示明文 + 刷新列表）。 */
  onCreated: (created: CreatedKey) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  // 默认 `all`：与旧行为一致（旧代码硬编码 all），避免升级后「按回车创建的密钥
  // 突然变成 trae 专用」这种静默行为变化。
  const [platform, setPlatform] = useState<PlatformValue>('all');
  const [busy, setBusy] = useState(false);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setLabel('');
      setPlatform('all');
      // Modal 打开时焦点交给首个可聚焦元素；关闭再开需重新归位
      labelRef.current?.focus();
    }
  }, [open]);

  const selected = PLATFORM_OPTIONS.find((o) => o.value === platform) ?? PLATFORM_OPTIONS[0];

  async function submit() {
    setBusy(true);
    try {
      const created = await createAccessKey(
        { label: label.trim() || undefined, platform },
        getKey(),
      );
      onCreated(created);
      toast('密钥已创建，请立即复制保存', 'ok');
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '创建失败，请稍后重试', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建访问密钥"
      desc="选择这把密钥能碰哪些平台的模型。明文仅在创建成功时返回一次。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="备注"
          ref={labelRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：VS Code / 爬虫脚本"
          aria-label="密钥备注"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />

        <div className="flex flex-col gap-2">
          <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
            平台
          </span>
          {/*
            用 radio 而不是 select：三个选项的差异（能调什么）是这张表单里
            最需要被读到的信息，select 会把 hint 藏进展开态，用户只看到三个
            短标签，很容易随手选「通用」然后继续用全能钥匙。
          */}
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="密钥平台">
            {PLATFORM_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-start gap-2 cursor-pointer"
                style={{ padding: '6px 8px', borderRadius: 6 }}
              >
                <input
                  type="radio"
                  name="api-key-platform"
                  value={opt.value}
                  checked={platform === opt.value}
                  onChange={() => setPlatform(opt.value)}
                  disabled={busy}
                  style={{ marginTop: 3 }}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span style={{ color: 'var(--rg-text-primary)' }}>{opt.label}</span>
                  <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {opt.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <Note>
          密钥的资源范围由平台自动决定（{selected.value} →{' '}
          {selected.value === 'all' ? <code>*</code> : <code>model:{selected.value}/*</code>}），
          不需要手填。需要进一步收窄时在密钥详情里改。
        </Note>
      </div>
    </Modal>
  );
}
