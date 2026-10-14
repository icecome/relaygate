/**
 * ZCode 接入弹窗：从本机 ZCode 桌面客户端导入登录态。
 *
 * 与 Trae / WorkBuddy / Qoder 的差异（对照后端 `src/zcode/local.js`）：
 *   - 凭据只能从 `~/.zcode/v2/credentials.json` 解出——字段级 AES-256-GCM 密文，
 *     密钥由「平台 + 家目录 + 用户名」派生。**没有「粘贴凭据」这条路**：
 *     客户端 JWT 无 `exp`、也不返回 refresh_token，上游不发放可移植凭据，
 *     所以本弹窗不提供粘贴框（那会是一个永远用不了的入口）；
 *   - 导入即启用（`store.add` 的 `enabled` 默认 true），也**必须**启用：
 *     套餐领取任务只枚举 `enabled` 的账号；
 *   - `capability.chat=false`：不参与对话转发，导入只是为了每日领取赠送套餐。
 *
 * 这是本次修复的靶心：此前 ZCode 后端全部就绪（preview + import + rewards），
 * 前端却连一个按钮都没有，账号根本接不进来。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { patchAccount } from '../../shared/api/credentials';
import { zcodeImportLocal, zcodeLocalPreview, type ZcodeLocalRealm } from '../../shared/api/zcode';
import { Button, Field, LoadingBlock, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

export function ImportZcodeDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [preview, setPreview] = useState<ZcodeLocalRealm | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  /** 已导入账号的 id + 是否处于停用态（停用时才需要引导启用） */
  const [imported, setImported] = useState<{ id: string; disabled: boolean } | null>(null);

  const loadPreview = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      setPreview(await zcodeLocalPreview(key));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取本机客户端失败', 'err');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [key, toast]);

  // 打开时探测一次；关闭时清空，避免下次打开看到上一次的旧结果
  useEffect(() => {
    if (open) {
      setImported(null);
      setLabel('');
      void loadPreview();
    } else {
      setPreview(null);
      setBusy(false);
    }
  }, [open, loadPreview]);

  async function doImport() {
    setBusy(true);
    try {
      const r = await zcodeImportLocal(key);
      const acct = r.account;
      if (!acct?.id) {
        toast('导入未返回账号，请查看服务端日志', 'err');
        return;
      }
      setImported({ id: acct.id, disabled: acct.enabled === false });
      toast(
        `${r.action === 'updated' ? '已更新' : '已导入'}：${acct.label || acct.id}`,
        'ok',
      );
      onImported();
    } catch (e) {
      // 解密失败是最常见的失败：密钥由本机用户名/家目录派生，
      // 客户端重装或改过用户名时必然不匹配，提示里要给出解法。
      const msg = e instanceof ApiError ? e.message : '导入失败';
      toast(/解密失败/.test(msg) ? `${msg}；可在 .env 设 ZCODE_CREDENTIAL_SECRET 显式指定密钥` : msg, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel() {
    if (!imported) return;
    setBusy(true);
    try {
      await patchAccount(imported.id, { label: label.trim() || undefined }, key);
      toast('备注已保存', 'ok');
      onImported();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  /** 更新既有账号时后端不改 enabled，被停用的账号需要这里显式启用。 */
  async function enableAndFinish() {
    if (!imported) return;
    setBusy(true);
    try {
      await patchAccount(imported.id, { enabled: true, label: label.trim() || undefined }, key);
      toast('账号已启用，将参与每日套餐领取', 'ok');
      onImported();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '启用失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  const account = preview?.account;
  const canImport = !!preview?.installed && !!account?.hasToken;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入 ZCode"
      desc="从本机 ZCode 桌面客户端读取登录态（凭据不出本机）"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {imported ? '完成' : '取消'}
          </Button>
          {imported ? (
            imported.disabled ? (
              <Button variant="primary" onClick={enableAndFinish} disabled={busy}>
                {busy ? '处理中…' : '启用并完成'}
              </Button>
            ) : (
              <Button variant="primary" onClick={saveLabel} disabled={busy}>
                {busy ? '保存中…' : '保存备注并完成'}
              </Button>
            )
          ) : (
            <Button variant="primary" onClick={doImport} disabled={!canImport || busy || loading}>
              {busy ? '导入中…' : '导入本机账号'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!imported && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={loadPreview} disabled={loading}>
              {loading ? '探测中…' : '重新探测'}
            </Button>
            {preview?.path && (
              <span className="text-[11px] break-all" style={{ color: 'var(--rg-text-tertiary)' }}>
                {preview.path}
              </span>
            )}
          </div>
        )}

        {loading && <LoadingBlock label="正在读取本机客户端凭据" />}

        {!loading && preview && !preview.installed && (
          <Note tone="warn">
            未找到 ZCode 客户端凭据文件：<code className="break-all">{preview.path}</code>
            <br />
            请先安装并登录 ZCode 桌面客户端（zcode.z.ai），登录后回到此处点「重新探测」。
          </Note>
        )}

        {!loading && preview?.installed && !account?.hasToken && (
          <Note tone="warn">
            凭据文件存在，但其中没有可用的登录 JWT——客户端可能尚未完成登录。
            请在客户端里登录一次后重试。
          </Note>
        )}

        {!loading && canImport && !imported && (
          <table className="card-table w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th">用户 ID</th>
                <th className="th">凭据模式</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr className="row-hover">
                <td className="td" data-label="账号">{account?.label || '—'}</td>
                <td className="td font-mono text-[12px]" data-label="用户 ID">
                  {account?.userId || '—'}
                </td>
                <td className="td" data-label="凭据模式">{account?.mode || '—'}</td>
                <td className="td" data-label="状态">已登录，可导入</td>
              </tr>
            </tbody>
          </table>
        )}

        {imported && (
          <>
            <Field
              label="备注（可选）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="留空则保留默认标签"
            />
            <Note>
              {imported.disabled
                ? '该账号当前处于停用状态。ZCode 的套餐领取只处理已启用账号，点「启用并完成」后才会参与每日 00:30 / 21:30 的探测。'
                : '导入即启用，已参与每日 00:30 / 21:30 的套餐探测与领取。ZCode 账号不参与对话转发（上游按设备指纹识别客户端，头形态未验证前不并入转发池）。'}
            </Note>
          </>
        )}

        {!imported && (
          <Note>
            解密只在本机进行：口令派生自「系统平台 + 家目录 + 用户名」，解出的 JWT 直接写入本服务数据库，
            不会发送到第三方。重复导入是安全的——同一 userId 只会更新，不会产生重复记录。
            客户端 JWT 长期有效且无 refreshToken，因此不需要保活。
          </Note>
        )}
      </div>
    </Modal>
  );
}
