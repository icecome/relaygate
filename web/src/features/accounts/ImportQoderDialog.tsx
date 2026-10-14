/**
 * Qoder 接入弹窗：从本机桌面客户端导入双区域账号。
 *
 * 与 Trae/WorkBuddy 的差异（对照后端 src/routes/qoder.js）：
 *   - 凭据只能从本机客户端 auth.v1.dat 解出（Chromium os_crypt v10 + DPAPI），
 *     没有「粘贴 JSON」这条路——上游不发放可移植凭据；
 *   - realm 由后端扫到哪个客户端目录确定，弹窗不传 realm，只负责展示探测结果；
 *   - 两个区域各自独立账号体系，可只导一个。
 *
 * 导入后账号默认 enabled=false：Qoder 转发面本期只开国际版单账号，
 * 且积分活动领取走 /v1/qoder 自己的定时任务，不参与 Trae 账号池调度。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { patchAccount } from '../../shared/api/credentials';
import {
  qoderImportLocal,
  qoderImportRealm,
  qoderLocalPreview,
  type QoderLocalPreview,
} from '../../shared/api/qoder';
import { Button, Field, LoadingBlock, Note } from '../../shared/ui';import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 单个区域的探测行（含导入结果）。 */
interface RealmRow {
  realm: 'cn' | 'intl';
  label: string;
}

const REALMS: RealmRow[] = [
  { realm: 'cn', label: '国内版' },
  { realm: 'intl', label: '国际版' },
];

/** realm → 可读的未安装原因（后端 preview 已给出 error，这里只做兜底）。 */
function reasonOf(r: QoderLocalPreview['realms']['cn']): string {
  if (r.installed && r.loggedIn) return '已登录，可导入';
  if (r.installed && !r.loggedIn) return '已安装但未登录，请在客户端完成登录';
  return r.error || '未检测到客户端';
}

export function ImportQoderDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();
  const [preview, setPreview] = useState<QoderLocalPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busyRealm, setBusyRealm] = useState<'cn' | 'intl' | 'all' | null>(null);
  const [label, setLabel] = useState('');
  const [importedId, setImportedId] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    if (!key) return;
    setLoadingPreview(true);
    try {
      setPreview(await qoderLocalPreview(key));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取本机客户端失败', 'err');
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  }, [key, toast]);

  // 打开时探测一次；关闭时清空，避免下次打开看到上一次的旧结果
  useEffect(() => {
    if (open) {
      setImportedId(null);
      setLabel('');
      void loadPreview();
    } else {
      setPreview(null);
      setBusyRealm(null);
    }
  }, [open, loadPreview]);

  async function doImportAll() {
    setBusyRealm('all');
    try {
      const r = await qoderImportLocal(key);
      const total = (r.created?.length || 0) + (r.updated?.length || 0);
      if (!total) {
        toast(r.message || '未导入任何账号（请确认客户端已安装并登录）', 'warn');
      } else {
        const first = r.created?.[0] || r.updated?.[0];
        setImportedId(first ? first.id : null);
        toast(
          `导入完成：新增 ${r.created?.length || 0}，更新 ${r.updated?.length || 0}`,
          (r.skipped?.length || 0) > 0 ? 'warn' : 'ok',
        );
        onImported();
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusyRealm(null);
    }
  }

  async function doImportRealm(realm: 'cn' | 'intl') {
    setBusyRealm(realm);
    try {
      const r = await qoderImportRealm(realm, key);
      if (r.account?.id) setImportedId(r.account.id);
      toast(`已导入${realm === 'cn' ? '国内版' : '国际版'}账号：${r.account?.label || r.account?.id || ''}`, 'ok');
      onImported();
      void loadPreview();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusyRealm(null);
    }
  }

  /** 就地启用刚导入的账号（Qoder 的积分领取与转发都要求 enabled）。 */
  async function enableImported() {
    if (!importedId) return;
    setBusyRealm('all');
    try {
      await patchAccount(importedId, { enabled: true, label: label.trim() || undefined }, key);
      toast('账号已启用', 'ok');
      onImported();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '启用失败', 'err');
    } finally {
      setBusyRealm(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入 Qoder"
      desc="从本机桌面客户端读取登录态（支持国内版与国际版双区域）"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {importedId ? '完成' : '取消'}
          </Button>
          {importedId ? (
            <Button variant="primary" onClick={enableImported} disabled={busyRealm === 'all'}>
              {busyRealm === 'all' ? '处理中…' : '启用并完成'}
            </Button>
          ) : (
            <Button variant="primary" onClick={doImportAll} disabled={busyRealm !== null || loadingPreview}>
              {busyRealm === 'all' ? '导入中…' : '导入全部区域'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!preview?.windows && (
          <Note>
            当前不在 Windows 上：Qoder 客户端凭据经 Chromium os_crypt v10 + DPAPI 加密，
            解密依赖 Windows 数据保护接口，非 Windows 系统无法从本机客户端导入。
          </Note>
        )}

        {loadingPreview && <LoadingBlock label="正在读取本机客户端" />}

        {preview?.windows && !loadingPreview && (
          <table className="card-table w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">区域</th>
                <th className="th">客户端</th>
                <th className="th">登录账号</th>
                <th className="th">状态</th>
                <th className="th">操作</th>
              </tr>
            </thead>
            <tbody>
              {REALMS.map(({ realm, label: realmLabel }) => {
                const r = preview.realms[realm];
                const canImport = !!r?.installed && !!r.loggedIn;
                return (
                  <tr key={realm} className="row-hover">
                    <td className="td" data-label="区域">{realmLabel}</td>
                    <td className="td font-mono text-[12px]" data-label="客户端">
                      {r?.clientVersion || '—'}
                    </td>
                    <td className="td" data-label="登录账号">
                      {r?.userName || r?.userEmail || (r?.userId ? String(r.userId).slice(0, 12) + '…' : '—')}
                    </td>
                    <td className="td" data-label="状态">
                      <span style={{ color: canImport ? 'var(--rg-text-primary)' : 'var(--rg-text-tertiary)' }}>
                        {r ? reasonOf(r) : '未探测'}
                      </span>
                    </td>
                    <td className="td" data-label="操作">
                      <Button
                        size="sm"
                        onClick={() => doImportRealm(realm)}
                        disabled={!canImport || busyRealm !== null}
                      >
                        {busyRealm === realm ? '导入中…' : '导入'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {importedId && (
          <>
            <Field
              label="备注（可选）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="留空则保留默认标签"
            />
            <Note>
              导入的账号默认停用。点击「启用并完成」后即可参与每日积分领取；
              国际版账号同时可参与对话转发（本期仅单账号，国内版转发未开放）。
            </Note>
          </>
        )}

        {!importedId && (
          <Note>
            导入过程仅在本机完成：解密后的凭据直接写入本服务数据库，不会发送到第三方。
            重复导入是安全的——同一区域的同一账号只会更新，不会产生重复记录。
          </Note>
        )}
      </div>
    </Modal>
  );
}
