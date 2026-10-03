import { useState } from 'react';
import Modal from './Modal';
import { buildExpiryRows } from '../stores/useExpiryWindow';
import { fmtBalance } from '../lib/format';
import type { Account } from '../api/types';

export interface ExpiryMeta {
  title: string;
  desc: string;
  rows: { name: string; packName: string; remaining: string; used: string; expire: string; win: string; is3: boolean }[];
}

/**
 * 临期积分明细。Trae / WorkBuddy 两侧原本各有一份完全相同的实现，
 * 收敛到这里，平台差异仅体现在描述文案（由调用方传入）。
 */
export default function ExpiryModal({
  meta,
  onClose,
}: {
  meta: ExpiryMeta | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!meta && !!meta.rows.length}
      onClose={onClose}
      title={meta?.title || '临期积分明细'}
      desc={meta?.desc}
      size="lg"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px] min-w-[480px]">
          <thead>
            <tr>
              <th className="th">权益包</th>
              <th className="th cell-num">剩余</th>
              <th className="th cell-num">已用</th>
              <th className="th cell-num">过期时间</th>
              <th className="th">窗口</th>
            </tr>
          </thead>
          <tbody>
            {meta?.rows.map((r, i) => (
              <tr key={i} className="row-hover [&>td]:px-3.5 [&>td]:py-3">
                <td>
                  <div className="font-medium">{r.name}</div>
                  <div className="acct-id">{r.packName}</div>
                </td>
                <td className="cell-num">{r.remaining}</td>
                <td className="cell-num text-ink-faint">{r.used}</td>
                <td className="cell-num text-ink-faint">{r.expire}</td>
                <td>
                  <span className={`${r.win === '已过期' || r.is3 ? 'pill-danger' : 'pill-warn'}`}>{r.win}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}

/** 由账号集合与窗口合计值构造临期弹窗数据 */
export function useExpiryMeta() {
  const [meta, setMeta] = useState<ExpiryMeta | null>(null);

  const open = (accounts: Account[], title: string, exp3: number, exp7: number) => {
    const rows = buildExpiryRows(accounts);
    setMeta({
      title,
      desc: `3 天内过期 ${fmtBalance(exp3)} · 7 天内过期 ${fmtBalance(exp7)} · 共 ${rows.length} 个临期包（数据来自最近一次余额刷新）`,
      rows,
    });
  };

  return { meta, open, close: () => setMeta(null) };
}
