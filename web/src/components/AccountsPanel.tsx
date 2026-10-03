import { useState } from 'react';
import StatCard from './StatCard';
import AccountTable from './AccountTable';
import AccountDetailModal from './AccountDetailModal';
import ExpiryModal, { useExpiryMeta } from './ExpiryModal';
import { Panel, ActionRow, WhoTag } from './ui';
import { OPS } from '../lib/ops';
import { useToast } from './Toast';
import { usePrompt } from './Prompt';
import { useSummary } from '../stores/useSummary';
import { useAuth } from '../stores/useAuth';
import { patchAccount, deleteAccount, refreshOneBalance, refreshAllBalance, resetDevice } from '../api/trae';
import { fmtBalance } from '../lib/format';
import type { Account, PoolAccount } from '../api/types';

/** 批量动作说明区块展示的三条主链 */
const BATCH_OPS = ['checkin', 'balance', 'keepalive'] as const;

export type Platform = 'all' | 'trae' | 'workbuddy';

/** 平台元信息：标题、空态文案、导入入口由调用方注入 */
export interface PlatformMeta {
  title: string;
  emptyTitle: string;
  emptyDesc: string;
  /** 导入按钮的渲染函数。用函数而非节点，避免同一 React 元素被挂到两处 */
  renderImport: () => React.ReactNode;
}

interface Props {
  platform: Platform;
  meta: PlatformMeta;
  /** 批量签到动作，各平台实现不同（Trae 走 checkinAll，WB 走 wbCheckinAll） */
  onCheckinAll: () => void;
  /** 子栏专属的额外动作按钮（Trae 的 OAuth 入口、WB 的成长中心等） */
  extraActions?: React.ReactNode;
  extraContent?: React.ReactNode;
  /** /status 的池快照，用于补「在途」列 */
  poolAccounts?: PoolAccount[];
}

/**
 * 账号总览面板。Trae 与 WorkBuddy 两个平台的账号池结构一致，
 * 原先由两个页面各自实现（约 200 行逐行重复），现收敛到此组件，
 * 平台差异通过 platform + meta 参数表达。
 */
export default function AccountsPanel({
  platform,
  meta,
  onCheckinAll,
  extraActions,
  extraContent,
  poolAccounts = [],
}: Props) {
  const { key } = useAuth();
  const { data, refresh, accountsOf } = useSummary();
  const toast = useToast();
  const prompt = usePrompt();
  const [detailAcct, setDetailAcct] = useState<Account | null>(null);
  const expiry = useExpiryMeta();

  const accts = accountsOf(platform);
  const exp3 = data?.expiring3d ?? 0;
  const exp7 = data?.expiring7d ?? 0;
  const totalBalance = accts.reduce((s, a) => s + (typeof a.balance === 'number' ? a.balance : 0), 0);
  const balCount = accts.filter((a) => typeof a.balance === 'number').length;
  const errN = accts.reduce((s, a) => s + (a.errorCount || 0), 0);
  const enabledN = accts.filter((a) => a.enabled).length;
  const coolingN = accts.filter((a) => a.coolUntil && new Date(a.coolUntil).getTime() > Date.now()).length;

  const onAction = async (action: { act: string; id: string; enabled?: boolean; label?: string }) => {
    try {
      switch (action.act) {
        case 'toggle':
          await patchAccount(action.id, { enabled: action.enabled ? 0 : 1 }, key);
          toast(action.enabled ? '已禁用账号' : '已启用账号');
          refresh();
          break;
        case 'cool':
          await patchAccount(action.id, { coolUntil: null }, key);
          toast('已清除冷却');
          refresh();
          break;
        case 'balance': {
          const r = await refreshOneBalance(action.id, key);
          if (r.balance == null) toast('已查询，当前无 credits 权益包或不可用');
          else {
            const extra = r.expiring && (r.expiring.d3 ?? 0) > 0 ? ` · 3 天内过期 ${fmtBalance(r.expiring.d3)}` : '';
            toast(`剩余积分 ${fmtBalance(r.balance)}${r.used != null ? ` · 已用 ${fmtBalance(r.used)}` : ''}${extra}`);
          }
          refresh();
          break;
        }
        case 'devreset': {
          const ok = await prompt({
            title: '重置设备指纹',
            message: '确定重置该账号的设备指纹？重置后将使用全新的设备身份（deviceGen +1）。',
            cancelText: '取消',
          });
          if (!ok) break;
          const r = await resetDevice(action.id, key);
          toast(`设备指纹已重置（gen=${r.deviceGen}，machineId=${r.machineId}…）`, 'ok');
          refresh();
          break;
        }
        case 'delete': {
          const ok = await prompt({
            title: '删除账号',
            message: `确定删除账号「${action.label || action.id}」？该操作不可恢复。`,
            danger: true,
            okText: '删除',
            cancelText: '取消',
          });
          if (!ok) break;
          await deleteAccount(action.id, key);
          toast('已删除账号');
          setDetailAcct(null);
          refresh();
          break;
        }
        case 'detail': {
          const a = accts.find((x) => x.id === action.id);
          if (!a) {
            toast('未找到账号', 'err');
            break;
          }
          setDetailAcct(a);
          break;
        }
      }
    } catch (e) {
      toast(`操作失败：${(e as Error).message}`, 'err');
    }
  };

  async function renameAccount(id: string, nextLabel: string) {
    try {
      await patchAccount(id, { label: nextLabel }, key);
      toast(`账号已重命名为 ${nextLabel}`, 'ok');
      setDetailAcct(null);
      refresh();
    } catch (e) {
      // 失败时不关闭弹窗，便于用户改名重试
      toast(`重命名失败：${(e as Error).message}`, 'err');
    }
  }

  const refreshAll = async () => {
    try {
      const r = await refreshAllBalance(key);
      toast(`余额已刷新：成功 ${r.ok.length} · 失败 ${r.failed.length}`);
      refresh();
    } catch (e) {
      toast(`批量刷新余额失败：${(e as Error).message}`, 'err');
    }
  };

  const openExpiry = (accounts: Account[], title: string) => expiry.open(accounts, title, exp3, exp7);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard label="账号数" value={accts.length} hint={`累计错误 ${errN} 次`} accent="acc" />
        <StatCard label="可用账号" value={enabledN} hint={`禁用 ${accts.length - enabledN} · 冷却 ${coolingN}`} />
        <StatCard label="余额合计" value={fmtBalance(totalBalance)} hint={`${balCount} 个账号有余额`} />
        <StatCard
          label="临期积分"
          value={fmtBalance(exp7)}
          hint={`3 天内 ${fmtBalance(exp3)} · 7 天内 ${fmtBalance(exp7)}`}
          accent="warn"
          clickable
          onClick={() => openExpiry(accts, `临期积分 · ${meta.title}`)}
        />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {meta.renderImport()}
        {extraActions}
        <button type="button" className="btn btn-ghost" onClick={onCheckinAll}>
          全部签到
        </button>
        <button type="button" className="btn btn-ghost" onClick={refreshAll}>
          刷新余额
        </button>
        <span className="ml-auto text-xs text-ink-faint tabular-nums">
          {data ? `共 ${accts.length} 个` : '加载中…'}
        </span>
      </div>

      <AccountTable
        accounts={accts}
        onAction={onAction}
        onOpenExpiry={(a) => openExpiry([a], `积分明细 · ${a.label || a.id}`)}
        emptyTitle={meta.emptyTitle}
        emptyDesc={meta.emptyDesc}
        extra={meta.renderImport()}
        poolAccounts={poolAccounts}
      />

      {extraContent}

      {/* 批量操作说明：把「动的是谁、什么副作用」写清，取代含义相近的一堆按钮 */}
      <Panel
        title="批量操作说明"
        desc="原界面存在「立即签到 / 全部签到 / 刷新余额」等多个入口，名字相近但行为不同。这里显式标注每个动作的作用对象与副作用。"
        bodyClass="px-5 pb-2"
      >
        {BATCH_OPS.map((k) => {
          const op = OPS[k];
          return (
            <ActionRow
              key={k}
              name={op.name}
              tag={<WhoTag who={op.who}>作用于{op.target}</WhoTag>}
              targetText={op.targetText}
              side={op.side}
              actions={
                k === 'checkin' ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onCheckinAll}>
                    执行
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={refreshAll}>
                    执行
                  </button>
                )
              }
            />
          );
        })}
      </Panel>

      <AccountDetailModal
        account={detailAcct}
        onClose={() => setDetailAcct(null)}
        onRename={renameAccount}
        onOpenExpiry={(a) => {
          setDetailAcct(null);
          openExpiry([a], `积分明细 · ${a.label || a.id}`);
        }}
      />

      <ExpiryModal meta={expiry.meta} onClose={expiry.close} />
    </div>
  );
}
