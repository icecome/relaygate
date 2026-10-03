import { useEffect, useState } from 'react';
import Modal from './Modal';
import { usePrompt } from './Prompt';
import { statePill, sourceLabel, fmtRegion, relTime, fmtCool, fmtBalance } from '../lib/format';
import type { Account } from '../api/types';

interface AccountDetailModalProps {
  account: Account | null;
  onClose: () => void;
  /** 重命名保存后触发，页面负责调 PATCH 并刷新 */
  onRename: (id: string, nextLabel: string) => Promise<void>;
  /** 查看积分明细 */
  onOpenExpiry?: (a: Account) => void;
}

function kv(k: string, v: React.ReactNode) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

export default function AccountDetailModal({ account, onClose, onRename, onOpenExpiry }: AccountDetailModalProps) {
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const open = !!account;

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  if (!account) return null;
  const a = account;

  const packs = (a.packs || [])
    .map((p) => `${p.name || '积分包'} ${p.unlimited ? '不限量' : fmtBalance(p.remaining)}`)
    .join('；');

  async function handleRename() {
    if (busy) return;
    const next = (await prompt({
      title: '修改账号名称',
      input: { label: '新名称', value: a.label || a.id },
      okText: '保存',
    })) as string;
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === (a.label || a.id)) return;
    setBusy(true);
    try {
      await onRename(a.id, trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`账号详情 · ${a.label || a.id}`}
      desc={a.id}
      size="lg"
      footer={
        <>
          {onOpenExpiry && (
            <button type="button" className="btn btn-ghost" onClick={() => onOpenExpiry(a)}>
              积分明细
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={handleRename} disabled={busy}>
            重命名
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="grid gap-2.5">
        {kv('状态', statePill(!a.enabled ? 'off' : a.coolUntil && new Date(a.coolUntil).getTime() > Date.now() ? 'cool' : 'ok'))}
        {kv('平台', String(a.edition ?? a.source ?? '').includes('workbuddy') ? 'WorkBuddy' : 'Trae')}
        {kv('来源', sourceLabel(a.source))}
        {kv('区域', fmtRegion(a.userRegion) || '—')}
        {kv('余额', <span className="font-semibold">{fmtBalance(a.balance)}</span>)}
        {kv('临期 3/7 天', `${fmtBalance(a.expiring3d)} / ${fmtBalance(a.expiring7d)}`)}
        {kv('权益包', packs || '—')}
        {kv('错误数', String(a.errorCount || 0))}
        {kv('最近调度', relTime(a.lastPickedAt))}
        {kv('最近签到', a.lastCheckinAt ? relTime(a.lastCheckinAt) : '—')}
        {kv('签到结果', a.lastCheckinResult || '—')}
        {kv('冷却至', fmtCool(a.coolUntil))}
      </div>
    </Modal>
  );
}