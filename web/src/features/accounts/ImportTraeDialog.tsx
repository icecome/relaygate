/**
 * Trae 凭据导入弹窗（粘贴 storage.json 或 refreshToken）。
 * 对应 POST /v1/credentials，字段与后端契约一致。
 */
import { useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { importMany, importTrae } from '../../shared/api/credentials';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

export function ImportTraeDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);

  /** 后端接受 storageJsonText 或 refreshToken，二者有其一即可。 */
  async function doImport() {
    const text = jsonText.trim();
    const token = refreshToken.trim();
    if (!text && !token) {
      toast('请粘贴 storage.json 内容或填写 refreshToken', 'warn');
      return;
    }
    setBusy(true);
    try {
      const account = await importTrae(
        {
          label: label.trim() || undefined,
          storageJsonText: text || undefined,
          refreshToken: token || undefined,
        },
        key,
      );
      toast(`已导入账号：${account.label || account.id || '新账号'}`, 'ok');
      onImported();
      onClose();
      setJsonText('');
      setRefreshToken('');
      setLabel('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  /** 批量导入：解析为对象数组后交给后端逐条处理。 */
  async function doImportMany() {
    const text = jsonText.trim();
    if (!text) {
      toast('请先粘贴要导入的内容', 'warn');
      return;
    }
    let items: object[];
    try {
      const parsed: unknown = JSON.parse(text);
      items = Array.isArray(parsed) ? (parsed as object[]) : [parsed as object];
    } catch {
      toast('内容不是合法 JSON', 'err');
      return;
    }
    setBusy(true);
    try {
      const r = await importMany(items, key);
      toast(
        `批量导入完成：成功 ${r.imported}，更新 ${r.updated.length}，失败 ${r.failed.length}`,
        r.failed.length > 0 ? 'warn' : 'ok',
      );
      onImported();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '批量导入失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="导入 Trae 凭据"
      desc="粘贴浏览器 storage.json，或直接填写 refreshToken"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={doImportMany} disabled={busy}>
            批量导入
          </Button>
          <Button variant="primary" onClick={doImport} disabled={busy}>
            {busy ? '导入中…' : '导入'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="备注（可选）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="留空则使用账号自带名称"
        />
        <div>
          <div className="text-[12px] mb-1.5" style={{ color: 'var(--rg-text-secondary)' }}>
            storage.json 内容
          </div>
          <textarea
            className="w-full h-40 p-2.5 rounded-md border font-mono text-[12px]"
            style={{ borderColor: 'var(--rg-border-stronger)' }}
            placeholder="粘贴单个对象或对象数组"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            aria-label="storage.json 内容"
          />
        </div>
        <Field
          label="refreshToken（与上面二选一）"
          value={refreshToken}
          onChange={(e) => setRefreshToken(e.target.value)}
          placeholder="仅有 refreshToken 时可直接填这里"
          aria-label="refreshToken"
        />
        <Note>
          凭据内容仅提交到本机后端，不会发送到第三方。批量导入会按数组逐条处理。
        </Note>
      </div>
    </Modal>
  );
}