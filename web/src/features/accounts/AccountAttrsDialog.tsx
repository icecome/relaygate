/**
 * 账号调度属性弹窗：分组 / 成本档 / 标签。
 *
 * 为什么单独一个弹窗：后端 PATCH /v1/credentials/:id 的白名单里有
 * `group`、`costTier`、`tags` 三个字段，但面板此前只暴露 enabled——
 * 三个字段能写不能看：
 *   - group 由 OAuth 登录时写入（Trae 授权弹窗里的「分组」），写完就没人能改；
 *   - costTier 直接决定选号顺序（credentials/pool.js 按 costTier 升序，
 *     0=免费额度包优先、2=收费），改错了会静默改变调度行为；
 *   - tags 目前只随导出/备份走，面板不显示。
 * 能配置却不能查看的字段必然漂移，这里补齐查看与修改的入口。
 */
import { useState } from 'react';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { patchAccount } from '../../shared/api/credentials';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 成本档：与后端 pool.js 的 costTierOf 口径一致（越小越优先）。 */
const COST_TIERS = [
  { value: 0, label: '0 · 免费额度包（最优先消耗）' },
  { value: 1, label: '1 · 未知 / 默认' },
  { value: 2, label: '2 · 收费额度（最后才用）' },
];

export function AccountAttrsDialog({ account, onClose, onSaved }: {
  /** null 表示弹窗关闭 */
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [group, setGroup] = useState<string | null>(null);
  const [costTier, setCostTier] = useState<number | null>(null);
  const [tags, setTags] = useState<string | null>(null);
  /**
   * 账号显示名。
   *
   * 此前这个弹窗只提交 group / costTier / tags —— 而 `PATCH /v1/credentials/:id`
   * 的白名单里一直含 `label`（src/routes/credentials.js:381）。后果是账号导入后
   * **完全无法改名**：一串 `2c4a8c26-546e-41dc-b82f-...` 只能靠删了重导换掉。
   * 重导会换 id、丢历史保活与签到记录，代价远大于改名本身。
   */
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // null = 未打开弹窗
  if (!account) return null;

  const accountId = account.id;

  // 首次打开时以账号当前值初始化（null 表示还没被用户碰过）
  const curLabel = label ?? account.label ?? '';
  const curGroup = group ?? account.group ?? '';
  const curTier = costTier ?? (typeof account.costTier === 'number' ? account.costTier : 1);
  const curTags = tags ?? (Array.isArray(account.tags) ? account.tags.join(', ') : '');

  async function save() {
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {
        // 显示名：空串 = 回落成 id 展示（前端 `a.label || a.id` 的既有语义）
        label: curLabel.trim(),
        // 空串 = 移出分组（后端 credentials.js 的既有约定）
        group: curGroup.trim(),
        costTier: curTier,
        tags: curTags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await patchAccount(accountId, patch, key);
      toast('调度属性已保存', 'ok');
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`调度属性 · ${account.label || account.id}`}
      desc="显示名、分组、成本档与标签；成本档会改变选号顺序"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="显示名（留空 = 用账号 ID）"
          value={curLabel}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如：主力 Trae CN"
        />
        <Field
          label="分组（留空 = 移出分组）"
          value={curGroup}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="例如：WorkBuddy"
        />
        <div>
          <label
            className="block text-label mb-2"
            htmlFor="acct-cost-tier"
          >
            成本档
          </label>
          <select
            id="acct-cost-tier"
            className="field w-full"
            value={curTier}
            onChange={(e) => setCostTier(Number(e.target.value))}
          >
            {COST_TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="标签（英文逗号分隔）"
          value={curTags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="例如：长期,备用"
        />
        <Note>
          选号按成本档升序（免费额度包优先消耗），同档内再按优先级与余额。
          改这里会立刻影响转发调度，不需要重启。
        </Note>
      </div>
    </Modal>
  );
}
