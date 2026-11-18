/**
 * 「最近操作与保活」分池面板。
 *
 * 为什么按池拆开（替代此前的一张大表）：旧表取 rows.slice(0, 8)，
 * 而行序是后端 store.list() 的插入顺序，Trae / WorkBuddy 在库里交错 ——
 * 「全部来源」视图永远混着两个池且静默截断尾部账号，用户只能切到
 * 单一来源筛选才看得全。现在逐池分组：每池一个汇总头 + 全部成员行，
 * 不截断、不混排；汇总头按整池口径算，成员行跟随当前筛选。
 *
 * ## 保活结论只有一个来源：渠道能力位 keepaliveMode（2026-11-17 重写）
 *
 * 此前的写法是从 `tokenRefresh || oauthLogin` 反推一个布尔，再配一句
 * 「未纳入扫描的平台不代表故障：Token 仍会在转发与签到前按需续期」。
 * 这句话与卡片上的「不参与定时保活」**互相打脸**：同一屏里，卡片说不保活，
 * 尾注说会按需续期，用户只能得出「到底保不保活？这里写保活，那里写不保活」。
 *
 * 根因是一个布尔压了三件事：
 *   1. 凭据会不会过期；
 *   2. 网关有没有实现续期；
 *   3. 定时轮覆不覆盖它。
 * 三态因此各自成立，必须分开写：
 *   - `scheduled`        参与定时保活：每轮逐个账号写 lastKeepaliveAt；
 *   - `not-needed`       无需保活：上游凭据没有到期概念、也没有续期端点
 *                        （ZCode：JWT 无 exp、不发 refresh_token）；
 *   - `not-implemented`  不保活：凭据**会**过期，但网关没有实现续期
 *                        （Qoder：有 jobToken/refresh 端点、轮换制 refresh_token，
 *                        未做多账号验证前不接），到期需手动重新导出凭据。
 * 尾注只说**已被证实**的事，且逐态给句子；不再出现「按需续期」这种
 * 对 not-implemented 平台根本不成立的兜底话。
 */
import type { Account } from '../../shared/api/types';
import type { Channel, ChannelCapability, KeepaliveMode } from '../../shared/api/channels';
import { formatDate, formatTime, platformIdLabel } from '../../shared/lib/format';
import { Chip, EmptyState } from '../../shared/ui';
import { keepaliveOf, keepalivePools, keepalivePoolOf } from './accountPacks';
import { KeepaliveSchedule } from './KeepaliveSchedule';

/**
 * 保活模式。优先读后端 `keepaliveMode`；老后端没这个位时按能力位兜底，
 * 兜底口径刻意**不说成「参与保活」**：`tokenRefresh || oauthLogin` 为假时
 * 只能断定「本轮不覆盖它」，断不定它是「无需」还是「没实现」，
 * 因此归到 `unknown`，文案只说「未纳入定时保活扫描」，不做原因解释。
 */
type KeepaliveDisplay = KeepaliveMode | 'unknown';

function keepaliveModeOf(cap: ChannelCapability | undefined): KeepaliveDisplay {
  if (!cap) return 'unknown';
  if (cap.keepaliveMode) return cap.keepaliveMode;
  return cap.tokenRefresh === true || cap.oauthLogin === true ? 'scheduled' : 'unknown';
}

/** 每个池的结论 chip 文案与色调。三态必须一眼可分，不能都叫「不参与保活」。 */
const MODE_META: Record<
  KeepaliveDisplay,
  { label: string; tone: 'ok' | 'danger' | 'warn' | 'neutral'; dot?: string; note: string }
> = {
  scheduled: {
    label: '参与定时保活',
    tone: 'ok',
    dot: 'dot-ok',
    note: '每日定时保活轮逐个账号续期并写入「最近保活」；临期账号在两轮之间也会被按需续期。该列有记录即表示链路已覆盖。',
  },
  'not-needed': {
    label: '无需保活',
    tone: 'neutral',
    note: '上游凭据没有到期概念、也不发放可续期凭据，因此没有保活动作可做。「最近保活」为空是设计使然，不是故障。',
  },
  'not-implemented': {
    label: '不保活 · 到期需手动更新',
    tone: 'warn',
    dot: 'dot-cool',
    note: '凭据会过期，但网关未实现该平台的续期链路（未做多账号验证前不接）。到期前需重新导出凭据并再次导入；「最近保活」为空属预期。',
  },
  unknown: {
    label: '未纳入定时保活扫描',
    tone: 'neutral',
    note: '后端未下发保活模式，只能确定定时轮不覆盖该平台；为空不代表故障。',
  },
};

export function KeepaliveBoard({
  accounts,
  channelById,
  rows,
}: {
  /** 全量账号（汇总头的整池口径，不受当前筛选影响） */
  accounts: Account[];
  /** 渠道能力位表（id → Channel），来自后端 /v1/admin/channels */
  channelById: Record<string, Channel>;
  /** 当前筛选命中的行（成员表体跟随筛选） */
  rows: Account[];
}) {
  const stats = keepalivePools(accounts);
  if (stats.length === 0) {
    return (
      <EmptyState
        label="没有启用中的账号"
        hint="只统计已启用账号，按平台汇总。"
      />
    );
  }
  // 卡片只显示当前筛选涉及的池；汇总头始终是整池口径
  const visible = stats.filter((s) => rows.some((a) => a.enabled && keepalivePoolOf(a) === s.platform));
  const shown = visible.length ? visible : stats;
  /**
   * 逐池的保活结论（平台名 → 模式），供尾注分组陈述。
   * 名单一律由渠道能力位派生，不写死平台名：写死必然随平台增加而漂移
   * （此前这里硬写「WorkBuddy / Qoder / ZCode 未纳入扫描」，
   * 而 WorkBuddy 的 tokenRefresh 早在 2026-10-18 就开了 —— 文案与实现相反）。
   */
  const modes = shown.map((s) => ({
    platform: s.platform,
    mode: keepaliveModeOf(channelById[s.platform]?.capability),
  }));
  const byMode = (m: KeepaliveDisplay) =>
    modes.filter((x) => x.mode === m).map((x) => platformIdLabel(x.platform));
  const scheduledNames = byMode('scheduled');
  const notNeededNames = byMode('not-needed');
  const notImplNames = byMode('not-implemented');
  const unknownNames = byMode('unknown');

  return (
    <div className="flex flex-col">
      {/*
        排程条置顶：回答「下一轮几点 / 上轮什么时候 / 这轮跑没跑」。
        账号级时间戳在下方表格里，两者是不同粒度，不能合并成一句
        （合并后用户会把「池最近保活 3 小时前」读成「所有账号都活着」）。
      */}
      <KeepaliveSchedule />
      <div className="flex flex-col gap-4 p-3">
      {shown.map((s) => {
        const mode = keepaliveModeOf(channelById[s.platform]?.capability);
        const meta = MODE_META[mode];
        const scanned = mode === 'scheduled';
        const members = rows.filter((a) => a.enabled && keepalivePoolOf(a) === s.platform);
        return (
          <div
            key={s.platform}
            className="overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--rg-border)' }}
          >
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-aux"
              style={{ background: 'var(--rg-bg-secondary)', color: 'var(--rg-text-secondary)' }}
            >
              <span className="text-[13px] font-medium" style={{ color: 'var(--rg-text-primary)' }}>
                {platformIdLabel(s.platform)}
              </span>
              <span>{s.accounts} 个启用账号</span>
              {scanned && s.never ? (
                /*
                  参与保活却一条记录都没有：这是**需要看一眼**的状态，但不是单一原因
                  （该池从未被跑过 / 刚导入还没到每日轮 / 调度未启动 / 续期全部失败）。
                  与「不参与保活所以为空」是两件事，此前两者共用一个灰 chip 的位置，
                  用户无法区分「设计使然」与「从没跑过」；这里报橙并列出可能原因，
                  不武断说成故障。
                */
                <Chip tone="warn" dot="dot-cool" title="可能原因：账号刚导入、还没到每日保活轮；或调度未启动 / 续期全部失败。临期账号会在 15 分钟的按需续期里先拿到记录。">
                  参与定时保活 · 尚无记录
                </Chip>
              ) : (
                <Chip tone={meta.tone} dot={meta.dot} title={meta.note}>
                  {meta.label}
                </Chip>
              )}
              {scanned && s.stale > 0 && (
                <Chip tone="warn" dot="dot-cool">
                  {s.stale} 个账号保活记录已超过一个执行周期
                </Chip>
              )}
              {s.failing > 0 && (
                <Chip tone="danger" dot="dot-error">
                  {s.failing} 个账号最近保活失败
                </Chip>
              )}
              {s.expiringSoon > 0 ? (
                <Chip tone="warn" dot="dot-cool">
                  {s.expiringSoon} 个账号 Token 7 日内到期
                </Chip>
              ) : s.expiryUnknown > 0 ? (
                /*
                  「均 7 日以上」这句话在到期时间未知时是假的担保：手动导入的
                  Qoder 账号库里没有 expiresAt，上游其实给了约 30 天有效期，
                  而本平台不参与自动续期（keepaliveMode=not-implemented）。
                  如实说「N 个账号到期时间未知」，让它与卡片上的保活结论同向。
                */
                <Chip tone="neutral" dot="dot-cool" title="该平台有到期概念，但库里没有 expiresAt（多为手动粘贴导入未带到期时间）。到期后需重新导出凭据导入。">
                  {s.expiryUnknown} 个账号到期时间未知
                </Chip>
              ) : s.noExpiryConcept > 0 ? (
                // 上游不发到期字段（ZCode）：说「无到期概念」，不说「7 日以上」
                <span title="该平台的上游凭据不返回到期时间（JWT 无 exp），因此没有到期概念">
                  无 Token 到期概念
                </span>
              ) : (
                <span>Token 均 7 日以上</span>
              )}
              <span className="font-mono text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                池最近保活：{s.lastAtMs == null ? '无' : formatTime(new Date(s.lastAtMs).toISOString())}
              </span>
            </div>
            {/* 表格自带横向滚动兜底：外层 .overflow-hidden 会在窄容器裁掉最后一列 */}
            <div className="overflow-x-auto">
              <table className="data-table table-fixed">
                <thead>
                  <tr>
                    <th scope="col" className="th col-account">账号</th>
                    <th scope="col" className="th">最近选用</th>
                    <th scope="col" className="th">最近签到</th>
                    <th scope="col" className="th">签到结果</th>
                    <th scope="col" className="th">最近保活</th>
                    <th scope="col" className="th">保活结果</th>
                    <th scope="col" className="th">Token 到期</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((a) => {
                    const k = keepaliveOf(a);
                    return (
                      <tr key={a.id} className="row-hover">
                        <td className="td font-mono text-aux truncate">
                          {a.label || a.id}
                        </td>
                        <td className="td font-mono text-aux">
                          {formatTime(a.lastPickedAt)}
                        </td>
                        <td className="td font-mono text-aux">
                          {formatTime(a.lastCheckinAt)}
                        </td>
                        <td className="td font-mono text-aux">
                          {a.lastCheckinResult || '—'}
                        </td>
                        <td className="td font-mono text-aux">
                          {a.lastKeepaliveAt ? formatTime(a.lastKeepaliveAt) : '—'}
                        </td>
                        <td
                          className="td font-mono text-aux truncate"
                          title={a.lastKeepaliveResult || undefined}
                        >
                          {a.lastKeepaliveResult || '—'}
                        </td>
                        <td
                          className="td font-mono text-aux truncate"
                          title={
                            k.expiresMs == null
                              ? k.label
                              : `登录 Token 到期：${formatTime(a.expiredAt)}`
                          }
                        >
                          {k.expiresMs == null ? k.label : `${formatDate(a.expiredAt)} ${k.label}`}
                        </td>
                      </tr>
                    );
                  })}
                  {members.length === 0 && (
                    <tr>
                      <td colSpan={7} className="td" style={{ color: 'var(--rg-text-tertiary)' }}>
                        当前筛选下该平台没有账号
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {/*
        尾注逐态陈述，且**只说已被证实的事**。此前这里对「未纳入扫描」的平台
        统一补一句「Token 仍会在转发与签到前按需续期」——那句话对 Qoder
        根本不成立（网关没有它的续期链路，转发面直接读库里的 token），
        对 ZCode 也不成立（它没有 refresh_token 可续）。一句兜底话把三种
        语义压成「都在保活」，正是与卡片上「不参与定时保活」打脸的成因。
      */}
      <div className="flex flex-col gap-1 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
        <p>
          「最近保活」由两条链路写入（<code>scheduler.runKeepalive</code> 每日轮 +
          临期扫描的按需续期），扫描周期见「运维 → 定时任务」。
          各平台的保活结论由其渠道能力位 <code>keepaliveMode</code> 决定，与
          <code>src/jobs/scheduler.js</code> 的账号过滤同源，前端不写死平台名单。
        </p>
        {scheduledNames.length > 0 && (
          <p>
            <strong style={{ color: 'var(--rg-text-secondary)' }}>参与定时保活</strong>
            （{scheduledNames.join(' / ')}）：每日轮逐个账号续期并写「最近保活」；
            临期账号在两轮之间也会被按需续期（结果标「ok（按需续期）」）。
            该列为空或超过一个执行周期，说明调度没跑或续期失败，属需要处理的问题。
          </p>
        )}
        {notNeededNames.length > 0 && (
          <p>
            <strong style={{ color: 'var(--rg-text-secondary)' }}>无需保活</strong>
            （{notNeededNames.join(' / ')}）：上游凭据没有到期概念，也不发放可续期凭据，
            因此没有保活动作可做。「最近保活」为空是设计使然，不是故障。
          </p>
        )}
        {notImplNames.length > 0 && (
          <p>
            <strong style={{ color: 'var(--rg-text-secondary)' }}>不保活</strong>
            （{notImplNames.join(' / ')}）：凭据<strong>会</strong>过期，
            但网关未实现该平台的续期链路，转发与签到前<strong>不会</strong>自动续期。
            到期前需重新导出凭据并再次导入；「最近保活」为空属预期。
          </p>
        )}
        {unknownNames.length > 0 && (
          <p>
            <strong style={{ color: 'var(--rg-text-secondary)' }}>未纳入定时保活扫描</strong>
            （{unknownNames.join(' / ')}）：后端未下发保活模式，只能确定定时轮不覆盖它。
          </p>
        )}
      </div>
      </div>
    </div>
  );
}
