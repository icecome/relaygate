import Modal from '../../components/Modal';
import type { RouterProvider } from '../../api/modelRouter';

/**
 * Provider 编辑弹窗（m-36：从 ModelRouterPage 拆出）。
 * 密钥仅填环境变量名（M-S6：明文密钥不落盘、不落前端）。
 */
interface Props {
  provEdit: RouterProvider | null;
  provId: string;
  busy: boolean;
  onClose: () => void;
  onProvEditChange: (p: RouterProvider) => void;
  onProvIdChange: (id: string) => void;
  onSave: () => void;
}

export default function ProviderEditModal({
  provEdit,
  provId,
  busy,
  onClose,
  onProvEditChange,
  onProvIdChange,
  onSave,
}: Props) {
  if (!provEdit) return null;
  return (
    <Modal
      open={!!provEdit}
      onClose={onClose}
      title="编辑 Provider"
      desc="Provider 是候选远端模型的来源，内置通道复用本平台账号池，OpenAI 兼容端点走外部服务。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onSave}>保存</button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block" htmlFor="prov-id">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">ID</span>
            <input
              id="prov-id"
              className="field w-full font-mono"
              value={provId}
              onChange={(e) => onProvIdChange(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="block" htmlFor="prov-label">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">标签</span>
            <input
              id="prov-label"
              className="field w-full"
              value={provEdit.label}
              onChange={(e) => onProvEditChange({ ...provEdit, label: e.target.value })}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block" htmlFor="prov-type">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">类型</span>
            <select
              id="prov-type"
              className="field w-full"
              value={provEdit.type}
              onChange={(e) =>
                onProvEditChange({ ...provEdit, type: e.target.value as 'builtin' | 'openai' })
              }
            >
              <option value="builtin">内置</option>
              <option value="openai">OpenAI 兼容</option>
            </select>
          </label>
          <div className="flex flex-col justify-end">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">状态</span>
            <label className="flex items-center gap-2 h-9 text-[13px] text-ink">
              <input
                type="checkbox"
                className="accent-acc"
                checked={provEdit.enabled}
                onChange={(e) => onProvEditChange({ ...provEdit, enabled: e.target.checked })}
              />
              启用
            </label>
          </div>
        </div>
        {provEdit.type === 'builtin' ? (
          <label className="block" htmlFor="prov-builtin">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">内置通道</span>
            <select
              id="prov-builtin"
              className="field w-full"
              value={provEdit.builtin || 'trae'}
              onChange={(e) =>
                onProvEditChange({ ...provEdit, builtin: e.target.value as 'trae' | 'workbuddy' })
              }
            >
              <option value="trae">trae</option>
              <option value="workbuddy">workbuddy</option>
            </select>
          </label>
        ) : (
          <>
            <label className="block" htmlFor="prov-baseurl">
              <span className="block text-xs font-medium text-ink-soft mb-1.5">Base URL</span>
              <input
                id="prov-baseurl"
                className="field w-full font-mono"
                value={provEdit.baseUrl || ''}
                onChange={(e) => onProvEditChange({ ...provEdit, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
            </label>
            <label className="block" htmlFor="prov-apikey-env">
              <span className="block text-xs font-medium text-ink-soft mb-1.5">API Key 环境变量名</span>
              <input
                id="prov-apikey-env"
                className="field w-full font-mono"
                value={provEdit.apiKeyEnv || ''}
                onChange={(e) => onProvEditChange({ ...provEdit, apiKeyEnv: e.target.value })}
                placeholder="MY_PROVIDER_API_KEY"
                spellCheck={false}
              />
              <span className="block text-[11.5px] text-ink-faint mt-1.5">
                只填写环境变量名，密钥本身从服务端环境读取，不落库到前端。
              </span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
