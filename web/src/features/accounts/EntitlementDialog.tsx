/**
 * 权益详情弹窗（单账号）。
 *
 * 替代原来的 PackDialog —— 后者只会渲染 `account.packs`，于是 ZCode / Qoder /
 * Raccoon 三个平台的账号点开后是「该账号没有权益包记录」的空态，而它们的额度
 * 明明在别的字段里（tokenBuckets / quota / raccoonPoints）。
 *
 * 按需拉取：弹窗打开时才 GET /v1/credentials/:id 取完整明细。列表端点走
 * `?slim=1`，packs 已被换成摘要，所以这里必须重新拉一次；这也是列表页
 * 每 60 秒的响应能从 121 KB 降到 ≈18 KB 的前提。
 *
 * 单位边界（整个文件最重要的约束）：
 *   积分（credit）/ Token / 配额 三者不可相加，也绝不放在同一列里比较。
 *   每个平台的表各自标注单位，没有「总计」这一行。
 */
import { useMemo } from 'react';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { getAccount } from '../../shared/api/credentials';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { Chip, EmptyState, ErrorState, LoadingBlock, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import {
  accountState,
  formatNumber,
  formatTime,
  platformLabel,
  platformOf,
  STATE_DOT_CLASS,
  STATE_LABEL,
} from '../../shared/lib/format';
import {
  amountUnitOf,
  entitlementOf,
  toneOfDays,
} from '../../shared/lib/entitlement';
import { packsOf, toMs, type PackView } from './accountPacks';

const URGENCY_META: Record<string, { label: string; tone: 'danger' | 'warn' | 'ok' | 'neutral'; dot?: string }> = {
  expired: { label: '已到期', tone: 'danger', dot: 'dot-error' },
  critical: { label: '3 日内', tone: 'danger', dot: 'dot-error' },
  warning: { label: '7 日内', tone: 'warn', dot: 'dot-cool' },
};

/** 后端凭据来源口径 → 面向用户的说法。 */
const SOURCE_LABEL: Record<string, string> = {
  import: '粘贴导入',
  oauth: 'OAuth 登录',
  local: '本机导入',
  login: '扫码登录',
  manual: '手动添加',
  workbuddy: '本机登录态',
};

export function EntitlementDialog({
  account,
  onClose,
}: {
  account: Account | null;
  onClose: () => void;
}) {
  const { key } = useAuth();
  // 弹窗打开时才拉详情：列表端点返回的是摘要（slim），没有完整 packs
  const detail = useAsyncData(
    (signal) => getAccount(account!.id, key, signal),
    [account?.id, key],
    { enabled: !!account && !!key },
  );

  if (!account) return null;

  const full = detail.data ?? account;
  const e = entitlementOf(full);
  const st = accountState(full);
  const platform = platformOf(full);

  return (
    <Modal
      open
      onClose={onClose}
      title={`权益 · ${account.label || account.id}`}
      desc={`${platformLabel(full)} · ${amountUnitOf(e)}计量`}
      size="lg"
      footer={
        <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
          {e.snapshotAt
            ? `快照更新于 ${formatTime(e.snapshotAt)}`
            : '尚未查询过上游额度'}
          {' · '}已用尽或已过期的条目不参与调度
        </span>
      }
    >
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <Chip tone="neutral" dot={STATE_DOT_CLASS[st]}>
          {STATE_LABEL[st]}
        </Chip>
        <span className="font-mono text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
          {account.id}
        </span>
        {SOURCE_LABEL[full.source ?? ''] && (
          <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
            来源：{SOURCE_LABEL[full.source ?? '']}
          </span>
        )}
        {e.stale && (
          <Chip tone="warn" dot="dot-cool">
            快照已过期
          </Chip>
        )}
      </div>

      {detail.error && <ErrorState message={detail.error} onRetry={detail.reload} />}
      {detail.loading && !detail.data && <LoadingBlock label="读取权益明细" />}

      {/* 摘要条：所有平台统一的一行读数 */}
      <div className="stat-strip mb-3">
        <span>
          剩余 <strong>{e.amountText}</strong> {amountUnitOf(e) !== '积分' ? amountUnitOf(e) : ''}
        </span>
        <span>{e.detailText}</span>
        <span>
          到期{' '}
          <strong
            style={{
              color:
                e.tone === 'expired' || e.tone === 'critical'
                  ? 'var(--rg-state-error)'
                  : e.tone === 'warning'
                    ? 'var(--rg-state-warning)'
                    : 'var(--rg-text-primary)',
            }}
          >
            {e.expiryText}
          </strong>
        </span>
        {e.expiring7d != null && e.expiring7d > 0 && (
          <span style={{ color: 'var(--rg-state-warning)' }}>
            7 日内到期 {formatNumber(e.expiring7d)}
          </span>
        )}
      </div>

      {platform === 'zcode' && <TokenBucketTable account={full} />}
      {platform === 'qoder' && <QuotaTable account={full} />}
      {platform === 'raccoon' && <RaccoonPoolTable account={full} />}
      {(platform === 'trae' || platform === 'workbuddy') && <PackTable account={full} />}
    </Modal>
  );
}

/* ---------- 积分口径：权益包表 ---------- */

function PackTable({ account }: { account: Account }) {
  const packs = useMemo(() => packsOf(account), [account]);
  if (packs.length === 0) {
    return (
      <EmptyState
        label="该账号还没有权益包数据"
        hint="权益包由上游签到 / 活动发放；点行内「查余额」会重新查询一次。"
      />
    );
  }
  const usable = packs.filter((p) => p.usable);
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th className="th">权益包</th>
            <th className="th cell-num">剩余 / 总量</th>
            <th className="th">到期时间</th>
            <th className="th cell-num">剩余天数</th>
            <th className="th">状态</th>
          </tr>
        </thead>
        <tbody>
          {packs.map((p) => (
            <tr key={p.key} style={p.usable ? undefined : { color: 'var(--rg-text-disabled)' }}>
              <td className="td">
                <span className="truncate" title={p.name}>{p.name}</span>
              </td>
              <td className="td cell-num">
                {p.unlimited
                  ? '不限量'
                  : `${formatNumber(p.remaining)}${p.limit != null ? ` / ${formatNumber(p.limit)}` : ''}`}
              </td>
              <td className="td td-mono">
                {p.expireMs == null ? '无到期时间' : formatTime(new Date(p.expireMs).toISOString())}
              </td>
              <td className="td cell-num">
                {p.expireMs == null ? '—' : p.days != null && p.days <= 0 ? '已过' : `${p.days} 天`}
              </td>
              <td className="td">
                <PackStatusChip pack={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
        共 {packs.length} 个包，其中 {usable.length} 个可用（{formatNumber(usable.reduce((s, p) => s + (p.remaining ?? 0), 0))} 积分）。
        失效项置底显示；「N 日内」标记表示距到期时间，不代表消耗顺序。
      </p>
    </>
  );
}

function PackStatusChip({ pack }: { pack: PackView }) {
  if (!pack.usable) {
    return <Chip tone="neutral">{pack.unusableReason ?? '不可用'}</Chip>;
  }
  const meta = pack.urgency ? URGENCY_META[pack.urgency] : null;
  if (!meta) {
    return (
      <Chip tone="ok" dot="dot-ok">
        可用
      </Chip>
    );
  }
  return (
    <Chip tone={meta.tone} dot={meta.dot}>
      {meta.label}
    </Chip>
  );
}

/* ---------- Token 口径：额度桶表 ---------- */

function TokenBucketTable({ account }: { account: Account }) {
  const buckets = Array.isArray(account.tokenBuckets) ? account.tokenBuckets : [];
  if (buckets.length === 0) {
    return (
      <EmptyState
        label="还没有查到额度桶"
        hint="ZCode 的额度按 Token 计量，需点行内「查额度」向上游查询一次；它与积分是两套计量，不会并入任何积分汇总。"
      />
    );
  }
  return (
    <>
      <Note>
        ZCode 额度以 <strong>Token</strong> 计量，与 Trae / WorkBuddy 的积分是两套独立单位，不可相加。
      </Note>
      <table className="data-table mt-3">
        <thead>
          <tr>
            <th className="th">额度桶</th>
            <th className="th cell-num">剩余 Token</th>
            <th className="th cell-num">总量</th>
            <th className="th cell-num">已用</th>
            <th className="th">到期时间</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => {
            const expireMs = toMs(b.expireTime);
            const days = expireMs == null ? null : Math.ceil((expireMs - Date.now()) / 86_400_000);
            const tone = toneOfDays(days);
            return (
              <tr key={`${b.bucketId ?? b.name ?? i}`}>
                <td className="td">
                  <span className="truncate" title={b.name}>{b.name || '未命名桶'}</span>
                </td>
                <td className="td cell-num">
                  {formatNumber(b.remaining)} <span className="text-unit">Token</span>
                </td>
                <td className="td cell-num">{formatNumber(b.limit)}</td>
                <td className="td cell-num">{formatNumber(b.used)}</td>
                <td className="td td-mono">
                  {expireMs == null ? (
                    '长期'
                  ) : (
                    <span
                      style={{
                        color:
                          tone === 'expired' || tone === 'critical'
                            ? 'var(--rg-state-error)'
                            : tone === 'warning'
                              ? 'var(--rg-state-warning)'
                              : 'var(--rg-text-secondary)',
                      }}
                    >
                      {formatTime(new Date(expireMs).toISOString())}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/* ---------- 配额口径：两段额度 ---------- */

function QuotaTable({ account }: { account: Account }) {
  const q = account.quota;
  if (!q) {
    return (
      <EmptyState
        label="还没有查到配额"
        hint="Qoder 的额度分「基础」与「赠送」两段，需点行内「查额度」向上游查询一次。"
      />
    );
  }
  const rows = [
    { key: 'base', label: '基础额度', seg: q.base },
    { key: 'addOn', label: '赠送额度', seg: q.addOn },
  ].filter((r) => r.seg != null);

  return (
    <>
      <Note>
        Qoder 的额度分两段：<strong>基础额度</strong>属套餐内在额度，
        <strong>赠送额度</strong>由签到与活动发放，两段独立、不互相包含。
        {q.userType ? `当前账号类型：${q.userType}。` : ''}
        {q.isQuotaExceeded ? ' 上游标记该账号配额已用尽。' : ''}
      </Note>
      <table className="data-table mt-3">
        <thead>
          <tr>
            <th className="th">额度段</th>
            <th className="th cell-num">剩余</th>
            <th className="th cell-num">总量</th>
            <th className="th cell-num">已用</th>
            <th className="th">到期时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="td">{r.label}</td>
              <td className="td cell-num">
                {formatNumber(r.seg!.remaining)} <span className="text-unit">配额</span>
              </td>
              <td className="td cell-num">{formatNumber(r.seg!.total)}</td>
              <td className="td cell-num">{formatNumber(r.seg!.used)}</td>
              <td className="td td-mono">
                {r.seg!.expiresAt ? formatTime(r.seg!.expiresAt) : '长期'}
              </td>
            </tr>
          ))}
          <tr>
            <td className="td" style={{ color: 'var(--rg-text-secondary)' }}>
              两段合计（仅供参考）
            </td>
            <td className="td cell-num" colSpan={4}>
              {formatNumber(q.totalRemaining)} <span className="text-unit">配额</span>
              <span className="ml-2 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                不并入其他平台的额度汇总
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

/* ---------- Raccoon：分池积分 ---------- */

function RaccoonPoolTable({ account }: { account: Account }) {
  const p = account.raccoonPoints;
  const pkgs = Array.isArray(p?.packages) ? p.packages : [];
  if (!p) {
    return (
      <EmptyState
        label="还没有查到积分分池"
        hint="Raccoon 的积分分「奖励 / 每日 / 充值」几个池，需点行内「查余额」向上游查询一次。"
      />
    );
  }
  return (
    <>
      <Note>
        <strong>每日积分</strong>由服务端按日发放、次日整额清零，因此没有「N 天后到期」；
        Raccoon 也没有签到端点，无需手动领取。
      </Note>
      {pkgs.length === 0 ? (
        <EmptyState label="没有分池明细" hint="上游只返回了总额，未给分池明细。" />
      ) : (
        <table className="data-table mt-3">
          <thead>
            <tr>
              <th className="th">积分池</th>
              <th className="th cell-num">剩余</th>
            </tr>
          </thead>
          <tbody>
            {pkgs.map((x, i) => (
              <tr key={`${x.name}-${i}`}>
                <td className="td">{x.name}</td>
                <td className="td cell-num">
                  {formatNumber(x.remaining)} <span className="text-unit">积分</span>
                </td>
              </tr>
            ))}
            <tr>
              <td className="td" style={{ color: 'var(--rg-text-secondary)' }}>
                合计
              </td>
              <td className="td cell-num">
                {formatNumber(p.available)} <span className="text-unit">积分</span>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}
