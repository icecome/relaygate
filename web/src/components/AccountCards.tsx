import type { Account, PoolAccount } from '../api/types';
import { accountState } from '../api/types';
import { fmtBalance, fmtCool, relTime } from '../lib/format';
import { WhoTag, EmptyState } from './ui';
import StatusDot from './StatusDot';

export interface AccountCardsProps {
  accounts: Account[];
  /** 点击卡片主体：打开详情 */
  onOpen: (a: Account) => void;
  /** 点击余额：打开积分明细 */
  onOpenExpiry: (a: Account) => void;
  poolAccounts?: PoolAccount[];
  emptyTitle?: string;
  emptyDesc?: string;
  extra?: React.ReactNode;
}

/**
 * 账号卡片视图：与表格共享同一数据源，作为「扫一眼状态」的替代排布。
 *
 * 设计说明（对应设计稿 v2 区块 07）：
 * 设计稿原画了「额度百分比带」，但 Account 类型并无额度上限字段（只有 balance 绝对值），
 * 画百分比条属于编造业务语义。此处改为呈现**确有依据的字段**：余额、错误数、在途、
 * 相对时间；状态仍然由 StatusDot 承担，避免为了「像仪表」而发明度量。
 */
export default function AccountCards({
  accounts,
  onOpen,
  onOpenExpiry,
  poolAccounts = [],
  emptyTitle = '账号池为空',
  emptyDesc = '暂无账号。',
  extra,
}: AccountCardsProps) {
  if (!accounts.length) {
    return (
      <EmptyState title={emptyTitle} desc={emptyDesc}>
        {extra}
      </EmptyState>
    );
  }

  const inFlightOf = new Map<string, number>();
  for (const p of poolAccounts) if (p.inFlight) inFlightOf.set(p.id, p.inFlight);

  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(268px,1fr))]">
      {accounts.map((a) => {
        const st = accountState(a);
        const err = a.errorCount || 0;
        const isWb = String(a.edition ?? a.source ?? '').includes('workbuddy');
        const inFlight = inFlightOf.get(a.id) ?? 0;
        return (
          <div
            key={a.id}
            className="bg-surf border border-line-hairline rounded-card p-4 flex flex-col gap-3 h-full transition-colors hover:border-line-strong"
          >
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpen(a)}
                className="min-w-0 text-left bg-none border-none p-0 cursor-pointer"
              >
                <div className="text-[13px] font-semibold text-ink truncate hover:text-acc">
                  {a.label || a.id}
                </div>
                <div className="acct-id truncate">{a.id}</div>
              </button>
              <WhoTag who={isWb ? 'who-wb' : 'who-trae'}>{isWb ? 'WorkBuddy' : 'Trae'}</WhoTag>
            </div>

            <StatusDot state={st} hint={st === 'cool' ? fmtCool(a.coolUntil) : undefined} />

            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line-hairline">
              <div className="min-w-0">
                <div className="text-[11px] text-ink-faint">余额</div>
                <button
                  type="button"
                  onClick={() => onOpenExpiry(a)}
                  title="查看积分包明细"
                  className="bg-none border-none p-0 text-[13px] font-medium tabular-nums text-ink cursor-pointer hover:text-acc"
                >
                  {fmtBalance(a.balance)}
                </button>
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-ink-faint">错误</div>
                <div className={`text-[13px] tabular-nums ${err > 0 ? 'text-danger font-semibold' : 'text-ink-faint'}`}>
                  {err}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-[11px] text-ink-faint">在途</div>
                <div className="text-[13px] tabular-nums text-ink-faint">{inFlight}</div>
              </div>
            </div>

            <div className="text-[11px] text-ink-faint mt-auto">最近调度 {relTime(a.lastPickedAt ?? null)}</div>
          </div>
        );
      })}
    </div>
  );
}
