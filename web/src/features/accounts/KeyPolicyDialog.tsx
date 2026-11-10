/**
 * 访问密钥的权限与配额弹窗。
 *
 * ## 为什么需要它
 *
 * `CreateAccessKeyDialog` 刻意不暴露 scopes / resources —— 那个决定是对的：
 * 平台决定默认值（`DEFAULT_SCOPES` / `DEFAULT_RESOURCES`），让用户在创建时手填
 * 资源路径，填错的表现是「密钥建出来了但调什么都 403」，而错误原因完全不指向
 * 那行配置。
 *
 * 但那套理由只在**创建那一刻**成立。一把已经跑起来的密钥，用户迟早要做两件事：
 *   1. 收窄——「这把原本给 IDE 的钥匙，现在只让它碰 glm 系列」；
 *   2. 延期——90 天 TTL 快到了，或需要 immediately 永久。
 * 此前这两件事**没有任何入口**（`PATCH /v1/api-keys/:id` 后端一直有，
 * `shared/api/apiKeys.ts` 里没有对应的客户端函数，页面也不渲染 scopes/rpm）。
 * 结果是「权限收窄」只剩「删了重建」一条路——而那会把已配好的 IDE 打断。
 *
 * ## 三条必须写进 UI 的陷阱
 *
 * 1. **platform 不可改**：不在 PATCH 白名单里。改平台等于悄悄扩大已分发密钥的
 *    适用范围。弹窗里只读展示，并写明「换平台请新建」。
 * 2. **清空 ≠ 取消权限**：`scopes: []` 会被 `normalizeScopes` 回落成平台默认值。
 *    所以「所有框都不勾」的结果是**权限变回默认**，不是「没有权限」。
 *    弹窗据此禁止提交空集合，并把这句话常驻在勾选区下方。
 * 3. **resources 与 scopes 是 AND**：scope 放行 + resource 不匹配，仍然是 403。
 *    只改其中一个就以为「改好了」是最常见的误判。
 */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import {
  KNOWN_SCOPES,
  KEY_SCOPES,
  keyDaysLeft,
  updateAccessKey,
  type ApiKeyRow,
} from '../../shared/api/apiKeys';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';
import { formatTime } from '../../shared/lib/format';

/** 平台展示名。后端只有三个取值（credentials/api-keys.js#PLATFORMS）。 */
const PLATFORM_LABEL: Record<string, string> = {
  all: '通用（全部模型）',
  trae: 'Trae 平台',
  workbuddy: 'WorkBuddy 平台',
};

interface Draft {
  label: string;
  scopes: string[];
  resources: string;
  rpmLimit: string;
  expiresAt: string;
}

/** ISO → `<input type="date">` 需要的 YYYY-MM-DD（本地时区）。 */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD` → 当日 23:59:59 本地时刻的 ISO；空串返回 null（永不过期）。 */
function dateInputToIso(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const d = new Date(`${t}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function KeyPolicyDialog({
  row,
  onClose,
  onSaved,
}: {
  /** 为 null 表示关闭 */
  row: ApiKeyRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({
    label: '',
    scopes: [],
    resources: '',
    rpmLimit: '',
    expiresAt: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 按当前行回填。依赖 row?.id 而不是 row 对象：列表刷新会换新对象，
  // 用对象做依赖会把用户正在编辑的内容冲掉。
  useEffect(() => {
    if (!row) return;
    setError(null);
    setDraft({
      label: row.label || '',
      // 后端可能返回未登记的历史 scope（正常情况不会有），过滤掉再展示，
      // 否则勾选区的 checked 全部落空、看起来像「这把钥匙没有权限」
      scopes: (row.scopes ?? []).filter((s) => KNOWN_SCOPES.has(s)),
      resources: (row.resources ?? []).join('\n'),
      rpmLimit: row.rpmLimit != null ? String(row.rpmLimit) : '',
      expiresAt: isoToDateInput(row.expiresAt),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const daysLeft = useMemo(() => keyDaysLeft(row?.expiresAt), [row?.expiresAt]);

  /** 解析成行、去空、去重；返回值与用户输入数量一起用于校验。 */
  const resourceList = useMemo(
    () =>
      draft.resources
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    [draft.resources],
  );

  function toggleScope(value: string) {
    setDraft((d) => ({
      ...d,
      scopes: d.scopes.includes(value) ? d.scopes.filter((s) => s !== value) : [...d.scopes, value],
    }));
    setError(null);
  }

  async function submit() {
    if (!row) return;
    if (!draft.scopes.length) {
      setError(
        '至少保留一个权限范围。全部取消会被后端回落成平台默认值（不是「没有权限」），' +
          '想彻底停用请用「停用」而不是清空权限。',
      );
      return;
    }
    if (!resourceList.length) {
      setError('资源范围不能为空。全部放开写 *，只放开 Trae 写 model:trae/*。');
      return;
    }
    if (draft.rpmLimit.trim()) {
      const n = Number(draft.rpmLimit);
      if (!Number.isFinite(n) || n <= 0) {
        setError('RPM 上限必须是正整数，留空表示不限制');
        return;
      }
    }

    setBusy(true);
    try {
      await updateAccessKey(
        row.id,
        {
          label: draft.label.trim() || null,
          scopes: draft.scopes,
          resources: resourceList,
          rpmLimit: draft.rpmLimit.trim() ? Number(draft.rpmLimit) : null,
          expiresAt: dateInputToIso(draft.expiresAt),
        },
        key,
      );
      toast('密钥权限已更新（下一次请求即生效，无需重启）', 'ok');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={`权限与配额：${row?.label || row?.hint || row?.id || ''}`}
      desc="改完立即生效。platform 不在可改字段里——换平台请新建一把密钥，改平台等于悄悄扩大已分发密钥的适用范围"
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
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 grid-cols-2">
          <Field
            label="备注"
            value={draft.label}
            placeholder="例如：VS Code / 爬虫脚本"
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
              平台（只读）
            </span>
            <div className="field flex items-center" style={{ color: 'var(--rg-text-tertiary)' }}>
              {PLATFORM_LABEL[row?.platform ?? 'all'] ?? row?.platform ?? '—'}
            </div>
          </div>
        </div>

        <div>
          <div className="text-label mb-2">权限范围（scopes）</div>
          <div className="flex flex-col gap-1.5" role="group" aria-label="权限范围">
            {KEY_SCOPES.map((s) => (
              <label key={s.value} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.scopes.includes(s.value)}
                  onChange={() => toggleScope(s.value)}
                  style={{ marginTop: 3 }}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span style={{ color: 'var(--rg-text-primary)' }}>
                    {s.label}
                    <code className="font-mono text-aux ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                      {s.value}
                    </code>
                  </span>
                  <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {s.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-3 grid-cols-2">
          <div className="flex flex-col gap-1 min-w-0">
            <label
              className="text-aux"
              style={{ color: 'var(--rg-text-secondary)' }}
              htmlFor="key-resources"
            >
              资源范围（每行一条，支持前缀通配）
            </label>
            <textarea
              id="key-resources"
              className="textarea"
              rows={4}
              value={draft.resources}
              onChange={(e) => setDraft((d) => ({ ...d, resources: e.target.value }))}
              placeholder={'*\nmodel:trae/*\nmodel:virtual:vm/unified-chat'}
            />
            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
              当前 {resourceList.length} 条。scope 放行 + 资源不匹配仍然是 403，
              两个维度是 AND 关系。
            </span>
          </div>
          <div className="flex flex-col gap-3">
            <Field
              label="每分钟请求上限（留空 = 不限）"
              type="number"
              inputMode="numeric"
              value={draft.rpmLimit}
              placeholder="60"
              onChange={(e) => setDraft((d) => ({ ...d, rpmLimit: e.target.value }))}
            />
            <div className="flex flex-col gap-1 min-w-0">
              <label
                className="text-aux"
                style={{ color: 'var(--rg-text-secondary)' }}
                htmlFor="key-expires"
              >
                过期日期（留空 = 永不过期）
              </label>
              <input
                id="key-expires"
                type="date"
                className="field w-full"
                value={draft.expiresAt}
                onChange={(e) => setDraft((d) => ({ ...d, expiresAt: e.target.value }))}
              />
              <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                {daysLeft == null
                  ? '当前：永不过期'
                  : daysLeft >= 0
                    ? `当前：${formatTime(row?.expiresAt)} 到期（还剩 ${daysLeft} 天）`
                    : `当前：已于 ${formatTime(row?.expiresAt)} 过期`}
              </span>
            </div>
          </div>
        </div>

        {error && (
          <Note tone="danger">
            <span className="break-all">{error}</span>
          </Note>
        )}

        <Note tone="warn">
          清空勾选**不会**让这把密钥失去权限，而是被后端回落成平台默认值。
          要立刻切断访问，用行内「停用」或「吊销」。
        </Note>
      </div>
    </Modal>
  );
}
