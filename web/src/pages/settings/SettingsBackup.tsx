import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../stores/useAuth';
import { useToast } from '../../components/Toast';
import { getBackup, saveBackup, runBackup, verifyBackup, type BackupSettings } from '../../api/admin';
import { fmtBytes } from './shared';

type Status = { msg: string; kind: '' | 'ok' | 'err' };

/** 全量备份视图（m-37：从 SettingsNotify 拆出——备份与通知是两个不相关领域）。 */
export default function SettingsBackup() {
  const { key } = useAuth();
  const toast = useToast();

  const [backup, setBackup] = useState<BackupSettings | null>(null);
  const [bkOn, setBkOn] = useState(false);
  const [bkDir, setBkDir] = useState('');
  const [bkKeep, setBkKeep] = useState('5');
  const [bkHours, setBkHours] = useState('24');
  const [bkStatus, setBkStatus] = useState<Status>({ msg: '', kind: '' });
  const [bkBusy, setBkBusy] = useState(false);
  const [bkVerifyMsg, setBkVerifyMsg] = useState<Status>({ msg: '', kind: '' });

  const loadBackup = useCallback(() => {
    if (!key) {
      setBackup(null);
      return;
    }
    getBackup(key)
      .then((d) => {
        setBackup(d);
        setBkOn(d.enabled);
        setBkDir(d.dir || '');
        setBkKeep(String(d.keep));
        setBkHours(String(d.intervalHours));
      })
      .catch(() => setBackup(null));
  }, [key]);

  useEffect(() => {
    loadBackup();
  }, [loadBackup]);

  async function saveBackupCfg() {
    if (!key) {
      setBkStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    try {
      const d = await saveBackup(
        { enabled: bkOn, dir: bkDir, keep: parseInt(bkKeep, 10) || 5, intervalHours: parseInt(bkHours, 10) || 24 },
        key,
      );
      setBackup(d);
      setBkOn(d.enabled);
      setBkDir(d.dir || '');
      setBkKeep(String(d.keep));
      setBkHours(String(d.intervalHours));
      setBkStatus({ msg: d.enabled ? `自动备份已启用（每 ${d.intervalHours} 小时 → ${d.dir}）` : '自动备份已关闭', kind: 'ok' });
      toast('备份配置已保存', 'ok');
    } catch (e) {
      setBkStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function runBackupNow() {
    if (!key || bkBusy) return;
    setBkBusy(true);
    setBkStatus({ msg: '备份进行中…（收集 → 加密 → 落盘 → 清理旧档）', kind: '' });
    try {
      const r = await runBackup(key);
      if (r.ok && r.file) {
        setBkStatus({ msg: `备份完成：${r.file}（${fmtBytes(r.sizeBytes)}）`, kind: 'ok' });
        toast('全量备份完成', 'ok');
      } else {
        setBkStatus({ msg: `备份失败：${r.error || '未知原因'}`, kind: 'err' });
        toast(`备份失败：${r.error || '未知原因'}`, 'err');
      }
      loadBackup();
    } catch (e) {
      setBkStatus({ msg: `备份失败：${(e as Error).message}`, kind: 'err' });
    } finally {
      setBkBusy(false);
    }
  }

  async function verifyBackupNow(path: string) {
    if (!key) return;
    try {
      const r = await verifyBackup(path, key);
      setBkVerifyMsg({ msg: r.ok ? `校验通过（${r.reason || ''}）` : `校验失败：${r.reason || ''}`, kind: r.ok ? 'ok' : 'err' });
      toast(r.ok ? '备份校验通过' : `备份校验失败：${r.reason || ''}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      setBkVerifyMsg({ msg: `校验失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-block-title font-semibold mb-1">全量备份</h2>
      <p className="text-xs text-ink-soft mb-4">
        备份内容：账号凭据（AES 加密密文）、API 密钥、积分历史、调度/通知/模型配置。备份文件单文件 JSON（含校验和），
        绝不含明文凭据。密钥来自 TRAE_BACKUP_PASSPHRASE 或 .trae-api/backup.key（自动生成）。完成自动推送「系统备份完成」通知。
      </p>
      {!key ? (
        <div className="text-xs text-ink-soft">保存访问密钥后可配置备份</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-on">
                <input id="bk-on" type="checkbox" className="w-4 h-4 accent-acc" checked={bkOn} onChange={(e) => setBkOn(e.target.checked)} />
                启用自动备份
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-dir">存储路径</label>
              <input
                id="bk-dir"
                className="field w-full font-mono text-xs"
                value={bkDir}
                onChange={(e) => setBkDir(e.target.value)}
                placeholder="backups（默认项目根目录 backups/）"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-keep">保留份数（1–50）</label>
              <input id="bk-keep" type="number" min={1} max={50} className="field w-full" value={bkKeep} onChange={(e) => setBkKeep(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-hours">自动备份间隔（小时，1–168）</label>
              <input id="bk-hours" type="number" min={1} max={168} className="field w-full" value={bkHours} onChange={(e) => setBkHours(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <button type="button" className="btn btn-primary" onClick={saveBackupCfg}>
                保存配置
              </button>
              <button type="button" className="btn btn-ghost" onClick={runBackupNow} disabled={bkBusy}>
                {bkBusy ? '备份中…' : '立即备份'}
              </button>
            </div>
          </div>
          {backup?.list && backup.list.length > 0 && (
            <div className="mt-3 border border-line-hairline rounded-card overflow-hidden">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] font-medium text-ink-soft [&>th]:px-3 [&>th]:py-2 [&>th]:border-b [&>th]:border-line-hairline">
                    <th className="th">备份文件</th>
                    <th className="th cell-num">大小</th>
                    <th className="th">校验和</th>
                    <th className="th cell-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {backup.list.map((b) => (
                    <tr key={b.file} className="row-hover [&>td]:px-4 [&>td]:py-2.5">
                      <td>
                        <div className="font-mono text-[11px]">{b.file}</div>
                        <div className="text-[10px] text-ink-faint">{b.path}</div>
                      </td>
                      <td className="cell-num">{fmtBytes(b.sizeBytes)}</td>
                      <td className="font-mono text-[10px] text-ink-faint">{b.checksum ? b.checksum.slice(0, 12) + '…' : '—'}</td>
                      <td className="cell-act">
                        <button type="button" className="btn-quiet" onClick={() => verifyBackupNow(b.path)}>
                          校验
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {bkVerifyMsg.msg && (
            <div role="status" className={`text-xs mt-2.5 ${bkVerifyMsg.kind === 'ok' ? 'text-acc-hover' : bkVerifyMsg.kind === 'err' ? 'text-danger' : ''}`}>
              {bkVerifyMsg.msg}
            </div>
          )}
          {bkStatus.msg && (
            <div role="status" className={`text-xs mt-2.5 ${bkStatus.kind === 'ok' ? 'text-acc-hover' : bkStatus.kind === 'err' ? 'text-danger' : ''}`}>
              {bkStatus.msg}
            </div>
          )}
        </>
      )}
    </div>
  );
}
