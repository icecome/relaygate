/**
 * WorkBuddy 接入弹窗。
 *
 * 两种导入方式（对应后端两种凭据来源）：
 *   方式一：抓取本机桌面客户端登录态（默认，后端会在线验证）；
 *   方式二：粘贴 .info 文件内容跨机导入（后端不做在线验证，导入后需补验）。
 *
 * 导入的账号默认停用，需在凭据池手动启用 —— 这里如实告知，避免用户以为导入即可用。
 */
import { useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { wbImport, wbLocal, wbVerify, type WbLocalInfo } from '../../shared/api/workbuddy';
import { Button, Field, LoadingBlock, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';

type Mode = 'local' | 'paste';

export function ImportWbDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();

  const [mode, setMode] = useState<Mode>('local');
  const [local, setLocal] = useState<WbLocalInfo | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [infoText, setInfoText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  async function detectLocal() {
    setLoadingLocal(true);
    try {
      setLocal(await wbLocal(key));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取本机登录态失败', 'err');
    } finally {
      setLoadingLocal(false);
    }
  }

  async function doImport() {
    setBusy(true);
    try {
      const body = mode === 'paste' ? { infoJsonText: infoText.trim(), label: label.trim() || undefined } : { label: label.trim() || undefined };
      if (mode === 'paste' && !infoText.trim()) {
        toast('请粘贴 .info 文件内容', 'warn');
        return;
      }
      const r = await wbImport(body, key);
      const isUpdate = r.action === 'updated';
      toast(
        `${isUpdate ? '已更新' : '已导入'} WorkBuddy 账号${r.label ? `：${r.label}` : ''}（默认停用）`,
        'ok',
      );
      onImported();
      onClose();

      // 跨机导入未做在线验证，引导补验
      if (mode === 'paste' && r.id) {
        const ok = await prompt({
          title: '立即验证该账号？',
          message: '跨机导入未做在线验证，验证通过后才能正常调度。',
          okText: '验证',
        });
        if (ok === true) {
          try {
            const v = await wbVerify({ accountId: r.id }, key);
            if (v.valid) {
              toast('验证通过', 'ok');
              onImported();
            } else {
              toast(`验证未通过：${v.reason ?? '后端未给出原因'}`, 'err');
            }
          } catch (e) {
            toast(e instanceof ApiError ? e.message : '验证失败', 'err');
          }
        }
      }
    } catch (e) {
      // 后端对加密 token、未找到登录态等情况有明确 code/文案，直接呈现
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入 WorkBuddy 账号"
      desc="凭据只来自本机客户端登录态或粘贴的 .info 文件，不接受手动输入 token"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={doImport} disabled={busy}>
            {busy ? '导入中…' : '导入'}
          </Button>
        </>
      }
    >
      <div className="mb-4">
        <Segmented
          ariaLabel="导入方式"
          value={mode}
          onChange={(v) => {
            setMode(v);
            if (v === 'local' && !local) void detectLocal();
          }}
          options={[
            { value: 'local', label: '抓取本机登录态' },
            { value: 'paste', label: '粘贴 .info 内容' },
          ]}
        />
      </div>

      {mode === 'local' ? (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-aux">本机桌面客户端登录态</span>
            <Button size="sm" onClick={detectLocal} disabled={loadingLocal}>
              {loadingLocal ? '检测中…' : '重新检测'}
            </Button>
          </div>
          {loadingLocal && !local ? (
            <LoadingBlock label="读取登录态" />
          ) : !local?.found ? (
            <Note>{local?.hint ?? '未找到 WorkBuddy 桌面端登录态'}</Note>
          ) : (
            <dl className="kv">
              <dt>昵称</dt>
              <dd>{local.nickname || '—'}</dd>
              <dt>uid</dt>
              <dd className="font-mono text-[12px] break-all">{local.uid || '—'}</dd>
              <dt>手机号</dt>
              <dd className="font-mono text-[12px]">{local.phoneNumber || '—'}</dd>
              <dt>区域</dt>
              <dd className="font-mono text-[12px]">{local.region || '—'}</dd>
              <dt>accessToken</dt>
              <dd className="font-mono text-[12px]">{local.accessToken || '—'}</dd>
              <dt>过期时间</dt>
              <dd className="font-mono text-[12px]">{local.expiresAt || '—'}</dd>
            </dl>
          )}
          <div className="mt-3">
            <Note>本机抓取会由后端在线验证凭据，无效凭据不会入库。</Note>
          </div>
        </div>
      ) : (
        <div>
          <textarea
            className="w-full h-40 p-2.5 rounded-md border font-mono text-[12px]"
            style={{ borderColor: 'var(--rg-border-stronger)' }}
            placeholder="粘贴 workbuddy-desktop.info 文件内容（JSON）"
            value={infoText}
            onChange={(e) => setInfoText(e.target.value)}
            aria-label="WorkBuddy info 文件内容"
          />
          <div className="mt-3">
            <Note>
              新版客户端的 .info 中 token 已加密，无法跨机导入；请改用「抓取本机登录态」。
            </Note>
          </div>
        </div>
      )}

      <div className="mt-4">
        <Field
          label="备注（可选）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="留空则使用账号昵称"
        />
      </div>

      <div className="mt-3">
        <Note>导入的账号默认处于停用状态，需在凭据池确认后手动启用。</Note>
      </div>
    </Modal>
  );
}