/**
 * Qoder 接入弹窗：两种导入方式（对应后端两条凭据来源）。
 *
 *   方式一「读取本机客户端」：解密桌面客户端 auth.v1.dat（双区域），
 *     Chromium os_crypt v10 + DPAPI，仅 Windows 同机可用；
 *   方式二「手动粘贴」：粘贴 dt- access token 或客户端凭据 JSON，
 *     用于服务端部署在 Linux、或接入别处机器上的账号。上游只认纯 Bearer 的
 *     dt- token，凭据本身可移植——所以这条路是真的可用（不像 ZCode，
 *     它的 JWT 由家目录派生，上游不发放可移植凭据，故无粘贴入口）。
 *
 * 与 Trae/WorkBuddy 的差异：
 *   - realm（国内版 / 国际版）是两个**独立的账号体系**。本机导入时由后端
 *     「扫到哪个客户端目录」确定；手动导入必须由用户显式选——国际版客户端的
 *     fastEndpoint 实测指向 api6.qoder.com.cn（一个 .com.cn 域名），
 *     按域名猜会把国际版误判成国内版；
 *   - 手动导入默认在线验证（后端用 userinfo 取回 uid/昵称/邮箱），
 *     无效 token 不会入库——否则它要到第一次领积分时才失败。
 *
 * 导入后账号即为**启用**状态：两条导入路径都不带 `enabled` 字段，
 * `store.add` 的默认是 `cred.enabled !== false` → true。
 * 底部「启用并完成」是幂等兜底：既保存备注，也保证既有账号若曾被停用会被启用。
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { patchAccount } from '../../shared/api/credentials';
import {
  qoderImportLocal,
  qoderImportManual,
  qoderImportRealm,
  qoderLocalPreview,
  type QoderLocalPreview,
} from '../../shared/api/qoder';
import { Button, Field, LoadingBlock, Note, Segmented } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 导入方式：本机客户端扫描 / 手动粘贴 token。 */
type Mode = 'local' | 'manual';

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
  const [mode, setMode] = useState<Mode>('local');
  const [preview, setPreview] = useState<QoderLocalPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busyRealm, setBusyRealm] = useState<'cn' | 'intl' | 'all' | null>(null);
  const [label, setLabel] = useState('');
  const [importedId, setImportedId] = useState<string | null>(null);

  // 手动粘贴表单
  const [realm, setRealm] = useState<'cn' | 'intl'>('intl');
  const [credential, setCredential] = useState('');
  const [verify, setVerify] = useState(true);

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
      setCredential('');
      setVerify(true);
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

  async function doImportRealm(target: 'cn' | 'intl') {
    setBusyRealm(target);
    try {
      const r = await qoderImportRealm(target, key);
      if (r.account?.id) setImportedId(r.account.id);
      toast(`已导入${target === 'cn' ? '国内版' : '国际版'}账号：${r.account?.label || r.account?.id || ''}`, 'ok');
      onImported();
      void loadPreview();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '导入失败', 'err');
    } finally {
      setBusyRealm(null);
    }
  }

  /** 手动粘贴导入：realm 由用户显式指定（两个区域是独立账号体系）。 */
  async function doImportManual() {
    const text = credential.trim();
    if (!text) {
      toast('请粘贴 Qoder 凭据（dt- token 或客户端凭据 JSON）', 'warn');
      return;
    }
    setBusyRealm('all');
    try {
      const r = await qoderImportManual(
        { realm, credential: text, label: label.trim() || undefined, verify },
        key,
      );
      if (!r.account?.id) {
        toast(r.message || '导入未返回账号，请查看服务端日志', 'err');
        return;
      }
      setImportedId(r.account.id);
      toast(
        `${r.action === 'updated' ? '已更新' : '已导入'}${r.verified === false ? '（未验证）' : ''}：${r.account.label || r.account.id}`,
        r.verified === false ? 'warn' : 'ok',
      );
      onImported();
    } catch (e) {
      // 后端 400 多为「token 无效 / 区域选错」，文案已可行动，直接呈现
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

  const importing = busyRealm === 'all';
  const manualReady = credential.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="接入 Qoder"
      desc="读取本机桌面客户端登录态，或手动粘贴 token（双区域账号体系独立）"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {importedId ? '完成' : '取消'}
          </Button>
          {importedId ? (
            <Button variant="primary" onClick={enableImported} disabled={importing}>
              {importing ? '处理中…' : '启用并完成'}
            </Button>
          ) : mode === 'manual' ? (
            <Button variant="primary" onClick={doImportManual} disabled={importing || !manualReady}>
              {importing ? '导入中…' : '导入'}
            </Button>
          ) : (
            <Button variant="primary" onClick={doImportAll} disabled={importing || loadingPreview}>
              {importing ? '导入中…' : '导入全部区域'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 导入后只留结果与备注，避免误触第二种方式的表单 */}
        {!importedId && (
          <Segmented
            ariaLabel="导入方式"
            value={mode}
            onChange={(v) => {
              setMode(v);
              // 切到本机模式时若还没有探测结果就拉一次（非 Windows 上首次打开会失败）
              if (v === 'local' && !preview && !loadingPreview) void loadPreview();
            }}
            options={[
              { value: 'local', label: '读取本机客户端' },
              { value: 'manual', label: '手动粘贴 token' },
            ]}
          />
        )}

        {!preview?.windows && mode === 'local' && !importedId && (
          <Note>
            当前不在 Windows 上：Qoder 客户端凭据经 Chromium os_crypt v10 + DPAPI 加密，
            解密依赖 Windows 数据保护接口，非 Windows 系统无法从本机客户端导入。
            可改用「手动粘贴 token」——上游只认纯 Bearer 的 dt- token，凭据本身可移植。
          </Note>
        )}

        {loadingPreview && mode === 'local' && <LoadingBlock label="正在读取本机客户端" />}

        {mode === 'local' && preview?.windows && !loadingPreview && !importedId && (
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
              {REALMS.map(({ realm: r, label: realmLabel }) => {
                const row = preview.realms[r];
                const canImport = !!row?.installed && !!row.loggedIn;
                return (
                  <tr key={r} className="row-hover">
                    <td className="td" data-label="区域">{realmLabel}</td>
                    <td className="td font-mono text-[12px]" data-label="客户端">
                      {row?.clientVersion || '—'}
                    </td>
                    <td className="td" data-label="登录账号">
                      {row?.userName || row?.userEmail || (row?.userId ? String(row.userId).slice(0, 12) + '…' : '—')}
                    </td>
                    <td className="td" data-label="状态">
                      <span style={{ color: canImport ? 'var(--rg-text-primary)' : 'var(--rg-text-tertiary)' }}>
                        {row ? reasonOf(row) : '未探测'}
                      </span>
                    </td>
                    <td className="td" data-label="操作">
                      <Button
                        size="sm"
                        onClick={() => doImportRealm(r)}
                        disabled={!canImport || busyRealm !== null}
                      >
                        {busyRealm === r ? '导入中…' : '导入'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {mode === 'manual' && !importedId && (
          <>
            <div>
              <div className="text-[12px] mb-1.5" style={{ color: 'var(--rg-text-secondary)' }}>
                区域（必选）
              </div>
              <Segmented
                ariaLabel="Qoder 区域"
                value={realm}
                onChange={setRealm}
                options={[
                  { value: 'cn', label: '国内版' },
                  { value: 'intl', label: '国际版' },
                ]}
              />
            </div>
            <div>
              <div className="text-[12px] mb-1.5" style={{ color: 'var(--rg-text-secondary)' }}>
                dt- access token 或客户端凭据 JSON
              </div>
              <textarea
                className="w-full h-32 p-2.5 rounded-md border font-mono text-[12px]"
                style={{ borderColor: 'var(--rg-border-stronger)' }}
                placeholder={'粘贴 dt- 开头的 token；或粘贴 auth.v1.dat 解密后的凭据 JSON\n{"token":"dt-…","refreshToken":"drt-…","expiresAt":"…","user":{"id":"…","name":"…","email":"…"}}'}
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                aria-label="Qoder 凭据"
              />
            </div>
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
              <input
                type="checkbox"
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
              />
              导入时在线验证（用 userinfo 确认 token 有效并取回账号信息）
            </label>
            <Note>
              区域必须选对：国内版与国际版是两套完全独立的账号体系（uid 不同、域名不同），
              token 不能跨区使用，且域名无法反推区域。
              {verify ? '验证失败不会入库。' : '已关闭验证——无效 token 会直接入库，直到下次领取积分时才暴露。'}
            </Note>
          </>
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
              导入即启用：账号可立即参与每日积分领取；国际版账号同时可参与对话转发
              （本期仅单账号，国内版转发未开放）。点「启用并完成」会保存备注，
              并确保该账号处于启用状态。
            </Note>
          </>
        )}

        {!importedId && mode === 'local' && (
          <Note>
            导入过程仅在本机完成：解密后的凭据直接写入本服务数据库，不会发送到第三方。
            重复导入是安全的——同一区域的同一账号只会更新，不会产生重复记录。
          </Note>
        )}
      </div>
    </Modal>
  );
}
