/**
 * 权益总览：按平台一行，可展开该平台的账号明细。
 *
 * ## 位置约定（2026-11-10 调整）
 *
 * 本块在凭据池页被提到**统计条之下、平台接入之上**。理由：进页面的第一问题
 * 是「各平台还剩多少、哪些快到期」，而不是「怎么接入新平台」。此前它在凭据
 * 表之后（第 4 位），必须滚过整张表才能看到。
 *
 * 上移带来的直接冲突是**与统计条数字重复**：统计条原本就报了
 * 「可用积分 / 可用权益包 / 7 日内到期」三项，而这三项正是本块的下钻视图。
 * 处置是把那三项从统计条**移进本块的汇总行**（见 `rollup` prop）——
 * 数字只留一处，统计条回归纯账号健康维度。
 *
 * ## 为什么这一块不做跨平台加总
 *
 * 后端刻意用四个隔离键存额度，因为它们不可相加：
 *   Trae / WorkBuddy → packs（积分，1e3 量级，可累积、有到期日）
 *   ZCode            → tokenBuckets（Token，1e8 量级，与积分不同维）
 *   Qoder            → quota（积分，基础 / 赠送两段各自有到期日）
 *   Raccoon          → raccoonPoints（积分，分池，每日积分次日清零）
 *
 * ⚠️ 计量列的写法（2026-11-17 订正）：除 ZCode 是 Token 外，四个平台上游单位
 * **都是积分**，所以这一列就写「积分」，不再给 Qoder 发明「配额」、给 Raccoon
 * 写「points」这个名字 —— 此前同一行的说明写「赠送 2,587」「奖励积分 / 每日积分」，
 * 一个数两个名字，读的人只能认为那一列在骗他。
 * 「都是积分」不等于「可以相加」：各平台积分价值不同、不可换算，
 * 差别写在每行的口径限定语（unitCaliberOf）里，分组与合计一律走内部键 `unit`。
 *
 * 此前面板只有「权益包」和「权益到期」两列且都只读 packs，于是实测
 * 7 / 23 个账号在权益包列显示「—」、23 / 23 个账号在到期列显示「—」
 * （worstExpiry 只在 ≤7 天返回非空，而实际最近到期是 8～22 天）。
 *
 * 这一块**不做跨平台加总**。积分 + Token 相加、或把三种不同值的积分相加，
 * 都是没有意义的数，而且这正是 ZCode 那一亿 token 曾被算进积分、
 * 把今日消耗抬高 4 个数量级的同一个坑。所以：分行展示，每行各自标注单位，
 * 页脚一句话说明为什么不相加。
 *
 * 唯一出现的「合计」是可累积积分（Trae + WorkBuddy），直接采用后端
 * `/v1/credentials?slim=1` 的 `rollup`，不在前端重算——重算就会与
 * `summarizeExpiry` / FEFO 的日历日判定差一天。
 */
import { useMemo, useState } from 'react';
import type { Account, EntitlementRollup } from '../../shared/api/types';
import { Chip, EmptyState } from '../../shared/ui';
import { formatNumber, formatTime, platformIdLabel } from '../../shared/lib/format';
import {
  entitlementOf,
  isStale,
  rollupByPlatform,
  unitCaliberOf,
  unitLabelOf,
  type PlatformRollup,
} from '../../shared/lib/entitlement';
import { packsOf, toMs } from './accountPacks';

export function EntitlementOverview({
  accounts,
  rollup,
}: {
  accounts: Account[];
  /**
   * 后端积分口径汇总（只覆盖 Trae + WorkBuddy）。
   *
   * 从统计条移进来的是这三个数：`usableAmount` / `usable` / `expiring7d`。
   * 传 null 时（老后端不带 `?slim=1` 的 rollup）汇总行整块不渲染，
   * 而不是显示 0 —— 0 会被读成「真的没有额度」。
   */
  rollup?: EntitlementRollup | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(() => rollupByPlatform(accounts), [accounts]);

  if (!rows.length) {
    return (
      <EmptyState
        label="还没有可统计的账号"
        hint="接入账号后执行一次余额查询，即可在此按平台查看额度。"
      />
    );
  }

  return (
    <>
      {rollup && <RollupStrip rollup={rollup} />}
      <div className="ent-rows" role="table" aria-label="各平台权益汇总">
        {rows.map((r) => (
          <PlatformRow
            key={r.platform}
            row={r}
            accounts={accounts}
            open={expanded === r.platform}
            onToggle={() => setExpanded((cur) => (cur === r.platform ? null : r.platform))}
          />
        ))}
      </div>
      <p className="mt-3 text-aux leading-relaxed fg-3">
        除 ZCode 按 Token 计量外，其余四个平台上游都按积分计量，但各平台积分价值不同、不可换算，因此不做跨平台总额；上方「可累积积分合计」只含 Trae 与 WorkBuddy（同一单位）。
      </p>
    </>
  );
}

/**
 * 可累积积分汇总行。
 *
 * 这三个数原属页面顶部统计条（`stat-strip`），2026-11-10 随权益总览上移一并
 * 搬到这里，避免同一屏出现两处相同的「可用积分」。
 *
 * 覆盖度必须写出来：`accounts` 是「至少有可用包的账号数」，小于账号总数时
 * 说明有账号没查过余额或包已用尽——用户看到 46,347 时要能判断它覆盖了几个号。
 *
 * 名字刻意叫「可累积积分」而不是「积分口径」：Qoder 与 Raccoon 的额度也是积分，
 * 只说「积分口径」会让人以为这一行已经把所有平台的积分都加进来了。
 */
function RollupStrip({ rollup }: { rollup: EntitlementRollup }) {
  return (
    <div className="ent-rollup">
      <span title="只加 Trae + WorkBuddy 的可累积积分（同一单位）；Qoder 与 Raccoon 的积分不同值、ZCode 是 Token，均在下方单列，不并入这一行">
        可累积积分合计{' '}
        <strong>{formatNumber(rollup.usableAmount)}</strong>
        <span className="text-unit"> 积分</span>
      </span>
      <span>
        可用权益包 <strong>{formatNumber(rollup.usable)}</strong> 个
        {rollup.unlimited > 0 && (
          <span style={{ color: 'var(--rg-text-tertiary)' }}> · 含不限量 {formatNumber(rollup.unlimited)}</span>
        )}
      </span>
      {rollup.expiring7d > 0 ? (
        <span style={{ color: 'var(--rg-state-warning)' }}>
          7 日内到期 <strong style={{ color: 'var(--rg-state-warning)' }}>{formatNumber(rollup.expiring7d)}</strong>
        </span>
      ) : (
        <span style={{ color: 'var(--rg-text-tertiary)' }}>7 日内无到期积分</span>
      )}
      <span style={{ color: 'var(--rg-text-tertiary)' }}>
        覆盖 {formatNumber(rollup.accounts)} 个账号
      </span>
    </div>
  );
}

function PlatformRow({
  row,
  accounts,
  open,
  onToggle,
}: {
  row: PlatformRollup;
  accounts: Account[];
  open: boolean;
  onToggle: () => void;
}) {
  const members = useMemo(
    () => accounts.filter((a) => entitlementOf(a).platform === row.platform),
    [accounts, row.platform],
  );
  const unit = unitLabelOf(row.unit);
  // 口径限定语：计量列现在四个平台里有三个都写「积分」，差别只能靠这句话讲清
  const caliberNote = unitCaliberOf(row.unit);
  const snapshotText = row.oldestSnapshotAt ? formatTime(row.oldestSnapshotAt) : '从未查询';

  return (
    <div className="ent-row" data-open={open ? 'on' : 'off'}>
      <button
        type="button"
        className="ent-head"
        aria-expanded={open}
        onClick={onToggle}
        title={open ? '收起明细' : '展开明细'}
      >
        <span className="ent-name">{platformIdLabel(row.platform)}</span>
        <span className="ent-unit" title={caliberNote}>{unit}</span>
        <span className="ent-amount">
          {row.known > 0 && row.amount != null ? formatNumber(row.amount) : '—'}
        </span>
        <span className="ent-detail">
          {row.detail || `${row.known}/${row.accounts} 个账号有数据`}
          {row.unit === 'credit' && row.items > 0 ? ` · ${row.items} 个可用包` : ''}
        </span>
        <span className="ent-expiry">
          {row.soonestDays == null ? (
            row.unit === 'credit' && row.accounts > 0 && row.known === 0 ? (
              <span style={{ color: 'var(--rg-text-tertiary)' }}>未查询</span>
            ) : (
              <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
            )
          ) : (
            <span
              style={{
                color:
                  row.soonestDays <= 3
                    ? 'var(--rg-state-error)'
                    : row.soonestDays <= 7
                      ? 'var(--rg-state-warning)'
                      : 'var(--rg-text-secondary)',
              }}
            >
              {row.soonestDays <= 0 ? '已到期' : `${row.soonestDays} 天后`}
            </span>
          )}
        </span>
        <span className="ent-snap" title={`最旧快照：${snapshotText}`}>
          {row.stale ? (
            <Chip tone="warn" dot="dot-cool">
              快照过期
            </Chip>
          ) : (
            <span style={{ color: 'var(--rg-text-tertiary)' }}>{snapshotText}</span>
          )}
        </span>
        <span className="ent-caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="ent-body">
          <PlatformDetail row={row} members={members} />
        </div>
      )}
    </div>
  );
}

/** 展开内容：按口径渲染各自的明细表。 */
function PlatformDetail({ row, members }: { row: PlatformRollup; members: Account[] }) {
  if (row.unit === 'token') return <TokenDetail members={members} />;
  if (row.unit === 'quota') return <QuotaDetail members={members} />;
  if (row.platform === 'raccoon') return <RaccoonDetail members={members} />;
  return <CreditDetail members={members} />;
}

/** 积分口径：逐账号 × 逐可用包（失效包不铺进来，避免几十行噪声）。 */
function CreditDetail({ members }: { members: Account[] }) {
  /**
   * 明细只能读 `packs`，而列表端点带 `?slim=1` 时 `packs` 被**整体移除**
   * （`entitlement-view.js#slimAccount` 解构丢弃，只留 `packDigest`）。
   *
   * 后果：行头按 `packDigest` 显示「1/1 个账号有数据 · 47 个可用包」，
   * 展开后却显示「该平台没有可用的权益包」——同一行上下两处自相矛盾。
   * 实测（隔离实例）：
   *   packs       : null
   *   packDigest  : { total:47, usable:47, usableAmount:3598, ... }
   *
   * 处置分两层：
   *   1. 有 `packDigest` 无 `packs` 时，用摘要出一行**聚合**读数并说明原因，
   *      不谎称「没有包」。逐包明细需要完整数据，指向单账号详情弹窗
   *      （`GET /v1/credentials/:id`，那条路径不带 slim）。
   *   2. 两者都没有，才走原来的空态。
   */
  const accounts = useMemo(() => {
    const withPacks: { account: Account; packs: ReturnType<typeof packsOf> }[] = [];
    const digestOnly: Account[] = [];
    for (const a of members) {
      if (Array.isArray(a.packs)) {
        withPacks.push({ account: a, packs: packsOf(a).filter((p) => p.usable) });
      } else if (a.packDigest) {
        digestOnly.push(a);
      }
    }
    return { withPacks: withPacks.filter((r) => r.packs.length > 0), digestOnly };
  }, [members]);

  const { withPacks, digestOnly } = accounts;

  // 只有摘要、没有任何逐包数据：给聚合读数 + 明确下一步，不留空态
  if (!withPacks.length && digestOnly.length) {
    let usableAmount = 0;
    let usable = 0;
    let expiring7d = 0;
    let soonest: number | null = null;
    for (const a of digestOnly) {
      const d = a.packDigest!;
      usableAmount += d.usableAmount;
      usable += d.usable;
      expiring7d += d.expiring7d;
      if (d.soonestDays != null && (soonest == null || d.soonestDays < soonest)) {
        soonest = d.soonestDays;
      }
    }
    return (
      <>
        <table className="data-table table-fixed">
          <thead>
            <tr>
              <th scope="col" className="th">账号</th>
              <th scope="col" className="th cell-num w-[88px]">可用包</th>
              <th scope="col" className="th cell-num col-w-num-wide">剩余积分</th>
              <th scope="col" className="th w-[120px]">最近到期</th>
            </tr>
          </thead>
          <tbody>
            {digestOnly.map((a) => {
              const d = a.packDigest!;
              return (
                <tr key={a.id} className="row-hover">
                  <td className="td">
                    <span className="truncate" title={a.id}>
                      {a.label || a.id}
                    </span>
                  </td>
                  <td className="td cell-num">{formatNumber(d.usable)}</td>
                  <td className="td cell-num">{formatNumber(d.usableAmount)}</td>
                  <td className="td td-mono fg-2">
                    {d.soonestDays == null
                      ? '长期'
                      : d.soonestDays <= 0
                        ? '已到期'
                        : `${d.soonestDays} 天后`}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="td font-semibold">合计</td>
              <td className="td cell-num font-semibold">{formatNumber(usable)}</td>
              <td className="td cell-num font-semibold">{formatNumber(usableAmount)}</td>
              <td className="td td-mono fg-2">
                {soonest == null ? '长期' : `${soonest} 天后`}
                {expiring7d > 0 && (
                  <span className="ml-1.5 fg-warn">
                    · 7 日内 {formatNumber(expiring7d)}
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2.5 text-aux leading-relaxed fg-3">
          这是后端下发的**权益摘要**（列表端点带 <code className="font-mono">?slim=1</code>，
          为省带宽不下发逐包明细）。需要看每个包的名称与到期时刻时，
          在下方凭据表点该账号「权益」列的「权益明细」。
        </p>
      </>
    );
  }

  if (!withPacks.length) {
    return (
      <EmptyState
        label="该平台没有可用的权益包"
        hint="包可能已用尽或过期，点行内「查余额」重新查询。"
      />
    );
  }

  return (
    <table className="data-table table-fixed">
      <thead>
        <tr>
          <th scope="col" className="th">账号</th>
          <th scope="col" className="th cell-num w-[88px]">可用包</th>
          <th scope="col" className="th cell-num col-w-num-wide">剩余</th>
          <th scope="col" className="th w-[120px]">最近到期</th>
        </tr>
      </thead>
      <tbody>
        {withPacks.map(({ account, packs }) => {
          const soonest = packs.reduce<typeof packs[number] | null>(
            (acc, p) => (p.expireMs != null && (acc == null || (acc.expireMs ?? 0) > p.expireMs) ? p : acc),
            null,
          );
          const sum = packs.reduce((s, p) => s + (p.remaining ?? 0), 0);
          return (
            <tr key={account.id} className="row-hover">
              <td className="td">
                <span className="truncate" title={account.id}>
                  {account.label || account.id}
                </span>
              </td>
              <td className="td cell-num">{packs.length}</td>
              <td className="td cell-num">{formatNumber(sum)}</td>
              <td className="td td-mono fg-2">
                {soonest == null
                  ? '长期'
                  : soonest.days != null && soonest.days <= 0
                    ? '已到期'
                    : `${soonest.days} 天后`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Token 口径：每个桶一行。 */
function TokenDetail({ members }: { members: Account[] }) {
  const rows = useMemo(() => {
    const out: { account: Account; name: string; remaining: number; limit: number; expireMs: number | null }[] = [];
    for (const a of members) {
      const buckets = Array.isArray(a.tokenBuckets) ? a.tokenBuckets : [];
      if (!buckets.length) {
        out.push({ account: a, name: a.tokenRemaining != null ? '合计（无分桶明细）' : '未查询', remaining: a.tokenRemaining ?? 0, limit: 0, expireMs: null });
        continue;
      }
      for (const b of buckets) {
        out.push({
          account: a,
          name: b.name || '未命名桶',
          remaining: Number(b.remaining) || 0,
          limit: Number(b.limit) || 0,
          expireMs: toMs(b.expireTime),
        });
      }
    }
    return out;
  }, [members]);

  return (
    <table className="data-table table-fixed">
      <thead>
        <tr>
          <th scope="col" className="th">账号</th>
          <th scope="col" className="th col-w-text">额度桶</th>
          <th scope="col" className="th cell-num col-w-num-wide">剩余 Token</th>
          <th scope="col" className="th cell-num col-w-num-wide">总量</th>
          <th scope="col" className="th">到期</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.account.id}-${i}`} className="row-hover">
            <td className="td">
              <span className="truncate" title={r.account.id}>
                {r.account.label || r.account.id}
              </span>
            </td>
            <td className="td">{r.name}</td>
            <td className="td cell-num">{formatNumber(r.remaining)}</td>
            <td className="td cell-num">{r.limit > 0 ? formatNumber(r.limit) : '—'}</td>
            <td className="td td-mono">
              {r.expireMs == null ? '长期' : formatTime(new Date(r.expireMs).toISOString())}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Qoder 两段积分：基础 / 赠送分列，不合并成一行。 */
function QuotaDetail({ members }: { members: Account[] }) {
  return (
    <table className="data-table table-fixed">
      <thead>
        <tr>
          <th scope="col" className="th">账号</th>
          <th scope="col" className="th cell-num col-w-num-wide">基础额度</th>
          <th scope="col" className="th cell-num col-w-num-wide">赠送额度</th>
          <th scope="col" className="th cell-num">合计</th>
          <th scope="col" className="th">到期</th>
        </tr>
      </thead>
      <tbody>
        {members.map((a) => {
          const q = a.quota;
          const base = q?.base?.remaining ?? null;
          const addOn = q?.addOn?.remaining ?? null;
          const expiries = [q?.base?.expiresAt ?? null, q?.addOn?.expiresAt ?? null].filter(Boolean) as string[];
          return (
            <tr key={a.id} className="row-hover">
              <td className="td">
                <span className="truncate" title={a.id}>{a.label || a.id}</span>
              </td>
              <td className="td cell-num">{base == null ? '—' : formatNumber(base)}</td>
              <td className="td cell-num">{addOn == null ? '—' : formatNumber(addOn)}</td>
              <td className="td cell-num">{q ? formatNumber(q.totalRemaining) : '—'}</td>
              <td className="td td-mono">{expiries.length ? formatTime(expiries[0]) : '长期'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Raccoon：分池。 */
function RaccoonDetail({ members }: { members: Account[] }) {
  return (
    <table className="data-table table-fixed">
      <thead>
        <tr>
          <th scope="col" className="th">账号</th>
          <th scope="col" className="th cell-num col-w-num-wide">合计</th>
          <th scope="col" className="th">分池</th>
          <th scope="col" className="th">快照</th>
        </tr>
      </thead>
      <tbody>
        {members.map((a) => {
          const p = a.raccoonPoints;
          const pkgs = Array.isArray(p?.packages) ? p.packages : [];
          const stale = isStale(p?.updatedAt);
          return (
            <tr key={a.id} className="row-hover">
              <td className="td">
                <span className="truncate" title={a.id}>{a.label || a.id}</span>
              </td>
              <td className="td cell-num">
                {p?.available == null ? '—' : formatNumber(p.available)}
              </td>
              <td className="td">
                {pkgs.length
                  ? pkgs.filter((x) => x.remaining > 0).map((x) => `${x.name} ${formatNumber(x.remaining)}`).join(' · ') || '全部为 0'
                  : '—'}
              </td>
              <td className="td td-mono">
                {stale ? (
                  <Chip tone="warn" dot="dot-cool">
                    {p?.updatedAt ? formatTime(p.updatedAt) : '未知'}
                  </Chip>
                ) : (
                  p?.updatedAt ? formatTime(p.updatedAt) : '—'
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
