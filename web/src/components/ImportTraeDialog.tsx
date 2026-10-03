import { useState } from 'react';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { importTrae } from '../api/trae';
import type { Account } from '../api/types';

interface ImportTraeDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: (r: Account) => void;
}

export default function ImportTraeDialog({ open, onClose, onDone }: ImportTraeDialogProps) {
  const { key } = useAuth();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [token, setToken] = useState('');
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'err' | '' }>({ msg: '', kind: '' });
  const [busy, setBusy] = useState(false);

  function reset() {
    setLabel('');
    setText('');
    setToken('');
    setFileName('');
    setStatus({ msg: '', kind: '' });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) {
      setFileName('');
      return;
    }
    setFileName(`${f.name} · ${f.size} 字节`);
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result || ''));
      setStatus({ msg: '已读取文件，可修改标签后导入', kind: '' });
    };
    reader.onerror = () => setStatus({ msg: '读取文件失败', kind: 'err' });
    reader.readAsText(f);
  }

  async function submit() {
    if (!text && !token) {
      setStatus({ msg: '请选择 storage.json 文件、粘贴内容，或粘贴 refreshToken/JWT', kind: 'err' });
      return;
    }
    setBusy(true);
    setStatus({ msg: '导入中…', kind: '' });
    try {
      const body = token ? { label: label || undefined, refreshToken: token } : { label: label || undefined, storageJsonText: text };
      const r = await importTrae(body, key);
      if (r.action === 'updated') {
        setStatus({ msg: `同 userId 已存在，已更新凭据 ${r.id}`, kind: 'ok' });
        toast('已更新已有账号（未重复添加）');
      } else {
        setStatus({ msg: `已导入账号 ${r.id || '（未知 id）'}`, kind: 'ok' });
        toast('导入成功');
      }
      onDone(r);
      setTimeout(onClose, 600);
    } catch (e) {
      const msg = (e as Error).message;
      setStatus({ msg: `导入失败：${msg}`, kind: 'err' });
      toast(`导入失败：${msg}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="导入账号"
      desc="选择本机 storage.json（含 iCubeAuthInfo），或粘贴文件内容。每次导入新增一条账号，不会覆盖已有记录。多账号请在 Trae 切换登录后分别导出再导入。"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            导入
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-ink mb-2" htmlFor="trae-label">
            标签（label）
          </label>
          <input id="trae-label" className="field w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 solo-01" autoComplete="off" />
        </div>

        <div>
          <span className="block text-xs font-semibold text-ink mb-2">选择文件</span>
          <input type="file" accept=".json,application/json" onChange={onFile} className="text-xs text-ink-soft" />
          <div className="text-xs text-ink-faint mt-1.5 break-all">{fileName || '尚未选择文件'}</div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-ink mb-2" htmlFor="trae-text">
            或粘贴 storage.json 内容
          </label>
          <textarea id="trae-text" className="field-area w-full h-[140px] p-2.5 font-mono text-xs leading-[1.4] resize-y" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder='{"iCubeAuthInfo://icube.cloudide":"..."}' />
        </div>

        <div>
          <label className="block text-xs font-semibold text-ink mb-2" htmlFor="trae-token">
            或粘贴 refreshToken / JWT 直接导入（无需 storage.json）
          </label>
          <input id="trae-token" className="field w-full" value={token} onChange={(e) => setToken(e.target.value)} placeholder="refresh_token（推荐，可自动续期）或 eyJ 开头的 JWT" autoComplete="off" />
          <div className="text-xs text-ink-faint mt-1.5">位置：Trae 客户端 storage.json 的 iCubeAuthInfo 节点内 refresh_token 字段</div>
        </div>

        {status.msg && (
          <div role="status" className={`text-xs ${status.kind === 'err' ? 'text-danger' : status.kind === 'ok' ? 'text-[#065F46]' : 'text-ink-soft'}`}>
            {status.msg}
          </div>
        )}
      </div>
    </Modal>
  );
}