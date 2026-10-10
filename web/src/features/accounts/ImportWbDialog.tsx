/**
 * WorkBuddy 接入弹窗。
 *
 * 两种导入方式（对应后端两种凭据来源）：
 *   方式一：抓取本机桌面客户端登录态（默认，后端会在线验证）；
 *   方式二：粘贴 .info 文件内容跨机导入（后端不做在线验证，导入后需补验）。
 *
 * 导入的账号默认停用。弹窗在导入成功后不自动关闭，而是就地给出「立即启用」，
 * 避免用户以为导入即可用、又找不到该去列表哪里启用。
 */
import { useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { patchAccount } from '../../shared/api/credentials';
import { wbImport, wbLocal, wbVerify, type WbLocalInfo } from '../../shared/api/workbuddy';
import { Button, Field, LoadingBlock, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

type Mode = 'local' | 'paste';

/** 导入成功后保留的结果，用于就地启用；null 表示还在导入表单态。 */
interface Imported {
  id?: string;
  label?: string;
  isUpdate: boolean;
  needVerify: boolean;
}

export function ImportWbDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>('local');
  const [local, setLocal] = useState<WbLocalInfo | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [infoText, setInfoText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<Imported | null>(null);

  function reset() {
    setImported(null);
    setInfoText('');
    setLabel('');
    setBusy(false);
  }

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

  /** 就地启用刚导入的账号，避免用户回到长列表里自己找。 */
  async function enableImported() {
    if (!imported?.id) return;
    setBusy(true);
    try {
      await patchAccount(imported.id, { enabled: true }, key);
      toast('账号已启用，可参与调度', 'ok');
      onImported();
      reset();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '启用失败，可在凭据池重试', 'err');
    } finally {
      setBusy(false);
    }
  }

  /** 跨机导入未做在线验证，就地补验。 */
  async function verifyImported() {
    if (!imported?.id) return;
    setBusy(true);
    try {
      const v = await wbVerify({ accountId: imported.id }, key);
      if (v.valid) {
        toast('验证通过', 'ok');
        onImported();
        setImported((prev) => (prev ? { ...prev, needVerify: false } : prev));
      } else {
        toast(`验证未通过：${v.reason ?? '凭据可能已失效，建议重新抓取本机登录态'}`, 'err');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '验证请求失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (mode === 'paste' && !infoText.trim()) {
      toast('请粘贴 .info 文件内容', 'warn');
      return;
    }
    setBusy(true);
    try {
      const body =
        mode === 'paste'
          ? { infoJsonText: infoText.trim(), label: label.trim() || undefined }
          : { label: label.trim() || undefined };
      const r = await wbImport(body, key);
      // 不关闭弹窗：把结果留在原地，让用户就地决定启用 / 验证
      setImported({
        id: r.id,
        label: r.label,
        isUpdate: r.action === 'updated',
        needVerify: mode === 'paste',
      });
      onImported();
    } catch (e) {
      // 后端对加密 token、未找到登录态等情况有明确 code/文案，直接呈现
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  if (imported) {
    return (
      <Modal
        open={open}
        onClose={() => {
          reset();
          onClose();
        }}
        title="账号已导入"
        desc="新导入的账号默认停用，确认无误后再启用"
        footer={
          <>
            <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
              稍后处理
            </Button>
            <Button variant="primary" onClick={enableImported} disabled={busy || !imported.id}>
              {busy ? '处理中…' : '立即启用'}
            </Button>
          </>
        }
      >
        <dl className="kv">
          <dt>状态</dt>
          <dd>{imported.isUpdate ? '已更新既有账号' : '已新建账号'}</dd>
          <dt>备注名</dt>
          <dd>{imported.label || '—'}</dd>
          <dt>调度状态</dt>
          <dd>停用（启用后才参与转发调度）</dd>
        </dl>
        {imported.needVerify && (
          <div className="mt-3">
            <Note tone="warn">
              跨机粘贴导入未做在线验证。
              <Button size="sm" className="ml-2" onClick={verifyImported} disabled={busy}>
                现在验证
              </Button>
            </Note>
          </div>
        )}
      </Modal>
    );
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
        <Note>导入后不会自动启用；下一步可直接在本弹窗内启用，或稍后在凭据池处理。</Note>
      </div>
    </Modal>
  );
}