import { useState } from 'react';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { wbLocal, wbImport } from '../api/workbuddy';

interface ImportWbDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export default function ImportWbDialog({ open, onClose, onDone }: ImportWbDialogProps) {
  const { key } = useAuth();
  const toast = useToast();
  const [detect, setDetect] = useState<{ msg: string; kind: 'ok' | 'err' | '' }>({ msg: '未检测', kind: '' });
  const [infoText, setInfoText] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<{ msg: string; kind: 'ok' | 'err' | '' }>({ msg: '', kind: '' });
  const [busy, setBusy] = useState(false);

  function reset() {
    setDetect({ msg: '未检测', kind: '' });
    setInfoText('');
    setLabel('');
    setStatus({ msg: '', kind: '' });
  }

  async function detectLocal() {
    setDetect({ msg: '检测中…', kind: '' });
    try {
      const r = await wbLocal(key);
      if (!r.found) {
        setDetect({ msg: r.hint || '未找到本机登录态', kind: 'err' });
        return;
      }
      setDetect({
        msg: `已找到：${r.nickname || r.phoneNumber || r.uid}（${String(r.region || '').toUpperCase()} 区，token 有效期至 ${String(r.expiresAt || '').slice(0, 10)}）——点击「导入」完成入库`,
        kind: 'ok',
      });
    } catch (e) {
      setDetect({ msg: `检测失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function submit() {
    setBusy(true);
    setStatus({ msg: '导入中…', kind: '' });
    try {
      const body = infoText.trim() ? { infoJsonText: infoText.trim(), label: label.trim() || undefined } : { label: label.trim() || undefined };
      const r = await wbImport(body, key);
      const id = r?.id ? r.id : '';
      if (r.verified === false) {
        setStatus({ msg: `已导入 ${id}（跨机凭据未验证：请启用后用「验证」或对话实测）`, kind: 'ok' });
      } else {
        setStatus({ msg: `已导入 ${id}，余额 ${r.verifiedBalance != null ? r.verifiedBalance : '未知'} credits（默认禁用，需手动启用）`, kind: 'ok' });
      }
      toast('导入成功');
      onDone();
      window.setTimeout(() => {
        onClose();
        reset();
      }, 900);
    } catch (e) {
      setStatus({ msg: `导入失败：${(e as Error).message}`, kind: 'err' });
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
      desc="同 userId 重复导入会更新已有账号。导入的账号默认禁用，需手动启用。"
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
          <span className="block text-xs font-semibold text-ink mb-2">方式一：抓取本机客户端登录态</span>
          <div className="text-xs text-ink-faint">要求本机 WorkBuddy 客户端已登录。自动完成验证并导入（导入后默认禁用，需手动启用）。</div>
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={detectLocal} disabled={busy}>
            检测本机登录态
          </button>
          <div role="status" className={`text-xs mt-2 ${detect.kind === 'err' ? 'text-danger' : detect.kind === 'ok' ? 'text-acc-hover' : 'text-ink-soft'}`}>
            {detect.msg}
          </div>
        </div>

        <div>
          <span className="block text-xs font-semibold text-ink mb-2">方式二：跨机导入（粘贴 workbuddy-desktop.info 文件内容）</span>
          <textarea
            className="field-area w-full h-[120px] p-2.5 font-mono text-xs leading-[1.4] resize-y"
            value={infoText}
            onChange={(e) => setInfoText(e.target.value)}
            spellCheck={false}
            placeholder='{"account":{...},"auth":{"accessToken":"...","refreshToken":"..."}}'
          />
          <div className="text-xs text-ink-faint mt-1.5">文件位置：%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info</div>
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-soft mb-2" htmlFor="wb-label">
            标签（可选）
          </label>
          <input id="wb-label" className="field w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="默认使用账号昵称/手机号" autoComplete="off" />
        </div>

        {status.msg && (
          <div role="status" className={`text-xs ${status.kind === 'err' ? 'text-danger' : status.kind === 'ok' ? 'text-acc-hover' : 'text-ink-soft'}`}>
            {status.msg}
          </div>
        )}
      </div>
    </Modal>
  );
}