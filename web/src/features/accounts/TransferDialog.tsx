/**
 * 账号导入/导出弹窗（跨机迁移，对标 WorkDaddy 账号页右上角的「导出 / 导入」）。
 *
 * 流程（对照 src/credentials/transfer.js）：
 *   1. 导出：POST /transfer/export {password, uids?} → 返回加密信封 JSON，
 *      前端触发浏览器下载 `RelayGate-账号导出-YYYY-MM-DD.json`；
 *   2. 导入：选择该文件 + 输入密码 → POST /transfer/import。
 *
 * 口令不进导出文件（信封 = gzip + AES-256-GCM，密钥由密码 scrypt 派生，
 * 每次导出随机 salt）。导出文件含可恢复登录态的 token，保存与传输要像密码一样对待。
 */
import { useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { listAccounts, transferExport, transferImport, type TransferImportResult } from '../../shared/api/credentials';
import { Button, Field, LoadingBlock, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { platformIdLabel, platformOf } from '../../shared/lib/format';

type Mode = 'export' | 'import';

/** 触发浏览器下载一个文本文件（不经过服务端，纯前端生成 Blob）。 */
function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TransferDialog({ open, onClose, onDone }: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('export');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState<TransferImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileText, setFileText] = useState('');
  const [fileName, setFileName] = useState('');

  const accounts = useAsyncData((signal) => listAccounts(key, signal), [key], { enabled: open && !!key });

  /**
   * 全量重置弹窗内的敏感中间态。
   *
   * 关闭与切换模式都必须走这里：只在关闭时清 password/password2 会留下
   * fileText/fileName（上次选的导出文件内容，含加密后的全部账号凭据）
   * 与 selected（上次的勾选集合），下次打开直接可见。
   */
  function resetAll() {
    setPassword('');
    setPassword2('');
    setFileText('');
    setFileName('');
    setSelected(new Set());
    setImportResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function close() {
    resetAll();
    onClose();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function doExport() {
    if (password.trim().length < 4) {
      toast('导出密码至少 4 个字符', 'warn');
      return;
    }
    if (password !== password2) {
      toast('两次输入的密码不一致', 'warn');
      return;
    }
    setBusy(true);
    try {
      const r = await transferExport(password, key, selected.size ? [...selected] : undefined);
      downloadText(r.filename, r.content);
      toast(`已导出 ${r.count} 个账号`, 'ok');
      onDone();
      resetAll();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导出失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setFileText(String(reader.result || ''));
    reader.onerror = () => toast('读取文件失败', 'err');
    reader.readAsText(f);
  }

  async function doImport() {
    if (!fileText.trim()) {
      toast('请先选择导出文件', 'warn');
      return;
    }
    if (!password.trim()) {
      toast('请输入导出时设置的密码', 'warn');
      return;
    }
    setBusy(true);
    try {
      const r = await transferImport(fileText, password, key);
      setImportResult(r);
      if (r.imported.length || r.updated.length) {
        toast(`导入完成：新建 ${r.imported.length} · 更新 ${r.updated.length}`, 'ok');
        onDone();
      } else {
        toast(r.skipped ? '文件中的账号均无效，未导入' : '没有可导入的账号', 'warn');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导入失败（密码或文件可能不正确）', 'err');
    } finally {
      setBusy(false);
    }
  }

  const rows = accounts.data ?? [];

  return (
    <Modal
      open={open}
      onClose={close}
      title="账号导入 / 导出"
      desc="跨机迁移：把全部（或所选）账号加密导出，在另一台机器安装 RelayGate 后导入"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            关闭
          </Button>
          {mode === 'export' ? (
            <Button variant="primary" onClick={doExport} disabled={busy}>
              {busy ? '导出中…' : '加密导出'}
            </Button>
          ) : (
            <Button variant="primary" onClick={doImport} disabled={busy}>
              {busy ? '导入中…' : '导入账号'}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Segmented
          ariaLabel="导入导出模式"
          value={mode}
          onChange={(v) => {
            setMode(v);
            // 切模式清空上一次的中间态（尤其是已读入的文件内容与密码）
            resetAll();
          }}
          options={[
            { value: 'export', label: '导出账号' },
            { value: 'import', label: '导入账号' },
          ]}
        />
      </div>

      {mode === 'export' ? (
        <div className="flex flex-col gap-4">
          <Field
            label="导出密码（不进文件，遗忘则无法恢复）"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 4 个字符"
          />
          <Field
            label="再次输入密码"
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            placeholder="确认密码"
          />

          <div>
            <div className="text-aux mb-1.5">
              导出范围：{selected.size ? `已选 ${selected.size} 个账号` : '全部账号'}
            </div>
            {accounts.loading && !accounts.data ? (
              <LoadingBlock label="读取账号" />
            ) : rows.length === 0 ? (
              <Note>当前没有任何账号。</Note>
            ) : (
              <div
                className="max-h-56 overflow-auto rounded-md border p-2 flex flex-col gap-1"
                style={{ borderColor: 'var(--rg-border)' }}
              >
                {rows.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="truncate">{a.label || a.id}</span>
                    <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                      {platformIdLabel(platformOf(a))}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <Note>
            导出文件包含可恢复登录态的 token，请像保护密码一样保存和传输；迁移完成后删除不再需要的副本。
            访问密钥不会导出（密钥绑定本机，不应跨机搬走）。
          </Note>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-aux mb-1.5">选择导出文件</div>
            {/* 原生 file input 未套样式时会与旁边 .field 形成两种外观 */}
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={onPickFile}
              aria-label="账号导出文件"
              className="block w-full text-aux file:mr-2 file:h-8 file:cursor-pointer file:rounded-md file:border file:px-3 file:text-[13px] file:bg-[var(--rg-bg-secondary)] file:text-[var(--rg-text-primary)]"
              style={{ color: 'var(--rg-text-secondary)' }}
            />
            {fileName && (
              <div className="text-aux mt-1 font-mono text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                {fileName}
              </div>
            )}
          </div>
          <Field
            label="导出密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="导出时设置的密码"
          />

          {importResult && (
            <Note tone={importResult.imported.length || importResult.updated.length ? 'neutral' : 'warn'}>
              导入完成：新建 {importResult.imported.length} · 更新 {importResult.updated.length} · 跳过{' '}
              {importResult.skipped}/{importResult.total}
              {importResult.skipped > 0 && '（跳过的行含无效 uid 或缺凭据的账号）'}
              {importResult.imported.length > 0 && '；新账号默认停用，请在凭据池验证后启用。'}
            </Note>
          )}

          <Note>导入按账号 uid 去重：同 uid 账号会更新凭据与元数据，新账号默认停用。</Note>
        </div>
      )}
    </Modal>
  );
}
