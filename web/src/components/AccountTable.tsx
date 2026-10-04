import type { Account, PoolAccount } from '../api/types';
import { accountState } from '../api/types';
import { fmtBalance, fmtCool } from '../lib/format';
import { WhoTag } from './ui';
import StatusDot from './StatusDot';
import RowMenu from './RowMenu';

export interface AccountRowAction {
  act: string;
  id: string;
  label?: string;
  enabled?: boolean;
}

export interface AccountTableProps {
  accounts: Account[];
  onAction: (action: AccountRowAction) => void;
  onOpenExpiry: (a: Account) => void;
  emptyTitle?: string;
  emptyDesc?: string;
  extra?: React.ReactNode;
  /** /status 的池快照，用于补「在途」列（凭据接口不提供该字段） */
  poolAccounts?: PoolAccount[];
}

/** 账号表：平台 / 账号 / 状态 / 余额 / 错误 / 在途 / 操作。
 *  原表含来源、区域、最近调度等列，信息密度高但运维动作不直观；
 *  这里按「一眼看清能不能用」排序，次要信息收进详情弹窗。 */
export default function AccountTable({
  accounts,
  onAction,
  onOpenExpiry,
  emptyTitle = '账号池为空',
  emptyDesc = '暂无账号，使用「导入」或「OAuth 登录」新增。',
  extra,
  poolAccounts = [],
}: AccountTableProps) {
  if (!accounts.length) {
    return (
      <div className="panel">
        <div className="text-center py-14 px-6">
          <div className="text-sm font-medium text-ink mb-1.5">{emptyTitle}</div>
          <div className="text-[13px] text-ink-soft mb-5 max-w-[380px] mx-auto leading-relaxed">{emptyDesc}</div>
          {extra}
        </div>
      </div>
    );
  }

  const inFlightOf = new Map<string, number>();
  for (const p of poolAccounts) if (p.inFlight) inFlightOf.set(p.id, p.inFlight);

  return (
    <div className="panel">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px] min-w-[720px]">
          <thead>
            <tr>
              <th className="th">平台</th>
              <th className="th">账号</th>
              <th className="th">状态</th>
              <th className="th cell-num">余额</th>
              <th className="th cell-num">错误</th>
              <th className="th cell-num">在途</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const st = accountState(a);
              const err = a.errorCount || 0;
              const isWb = String(a.edition ?? a.source ?? '').includes('workbuddy');
              const hasPacks = Array.isArray(a.packs) && a.packs.length > 0;
              const exp3 = Number(a.expiring3d) || 0;
              const exp7 = Number(a.expiring7d) || 0;
              const name = a.label || a.id;
              return (
                <tr key={a.id} className="row-hover">
                  <td className="td">
                    <WhoTag who={isWb ? 'who-wb' : 'who-trae'}>{isWb ? 'WorkBuddy' : 'Trae'}</WhoTag>
                  </td>
                  <td className="td">
                    <button
                      type="button"
                      onClick={() => onAction({ act: 'detail', id: a.id })}
                      className="bg-none border-none p-0 text-ink font-medium cursor-pointer hover:text-acc"
                    >
                      {name}
                    </button>
                    <div className="acct-id">{a.id}</div>
                  </td>
                  <td className="td">
                    <StatusDot state={st} hint={st === 'cool' ? fmtCool(a.coolUntil) : undefined} />
                  </td>
                  <td className="td cell-num">
                    {hasPacks || exp3 > 0 || exp7 > 0 ? (
                      <span className="inline-flex flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => onOpenExpiry(a)}
                          title="查看积分包明细"
                          className="bg-none border-none p-0 tabular-nums text-ink font-medium cursor-pointer hover:text-acc"
                        >
                          {fmtBalance(a.balance)}
                        </button>
                        {exp3 > 0 ? (
                          <span className="pill-danger" title="3 天内过期">
                            3天 {fmtBalance(exp3)}
                          </span>
                        ) : exp7 > 0 ? (
                          <span className="pill-warn" title="7 天内过期">
                            7天 {fmtBalance(exp7)}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="tabular-nums font-medium text-ink">{fmtBalance(a.balance)}</span>
                    )}
                  </td>
                  <td className={`td cell-num ${err > 0 ? 'text-danger font-semibold' : 'text-ink-faint'}`}>{err}</td>
                  <td className="td cell-num text-ink-faint" title="该账号当前在途请求数">
                    {inFlightOf.get(a.id) ?? 0}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    {/* 主操作按当前状态推导：正常→签到（最常用），冷却→清冷却，停用→启用。
                        其余操作收进「更多」，避免一屏十几行都是并列按钮。 */}
                    {st === 'cool' ? (
                      <button
                        type="button"
                        className="btn-quiet text-xs"
                        title="清除账号冷却时间，使其立即重新参与调度"
                        onClick={() => onAction({ act: 'cool', id: a.id })}
                      >
                        清冷却
                      </button>
                    ) : st === 'off' ? (
                      <button
                        type="button"
                        className="btn-quiet text-xs"
                        title="重新启用该账号"
                        onClick={() => onAction({ act: 'toggle', id: a.id, enabled: a.enabled })}
                      >
                        启用
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-quiet text-xs"
                        onClick={() => onAction({ act: 'checkin', id: a.id })}
                      >
                        签到
                      </button>
                    )}
                    <span className="ml-1">
                      <RowMenu
                        items={[
                          { key: 'detail', label: '详情', onSelect: () => onAction({ act: 'detail', id: a.id }) },
                          { key: 'balance', label: '刷余额', onSelect: () => onAction({ act: 'balance', id: a.id }) },
                          {
                            key: 'toggle',
                            label: a.enabled ? '禁用' : '启用',
                            onSelect: () => onAction({ act: 'toggle', id: a.id, enabled: a.enabled }),
                          },
                          {
                            key: 'cool',
                            label: '清冷却',
                            onSelect: () => onAction({ act: 'cool', id: a.id }),
                          },
                          { key: 'checkin', label: '签到', onSelect: () => onAction({ act: 'checkin', id: a.id }) },
                          {
                            key: 'devreset',
                            label: '重置指纹',
                            onSelect: () => onAction({ act: 'devreset', id: a.id }),
                          },
                          {
                            key: 'delete',
                            label: '删除',
                            danger: true,
                            onSelect: () => onAction({ act: 'delete', id: a.id, label: a.label || a.id }),
                          },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-5 py-2.5 border-t border-line-hairline text-[11.5px] text-ink-faint">
        操作列的首个按钮随账号状态变化（正常→签到，冷却→清冷却，停用→启用），其余操作在「更多」中。
      </div>
    </div>
  );
}
