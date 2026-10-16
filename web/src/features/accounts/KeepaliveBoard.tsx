/**
 * 「最近操作与保活」分池面板。
 *
 * 为什么按池拆开（替代此前的一张大表）：旧表取 rows.slice(0, 8)，
 * 而行序是后端 store.list() 的插入顺序，Trae / WorkBuddy 在库里交错 ——
 * 「全部来源」视图永远混着两个池且静默截断尾部账号，用户只能切到
 * 单一来源筛选才看得全。现在逐池分组：每池一个汇总头 + 全部成员行，
 * 不截断、不混排；汇总头按整池口径算，成员行跟随当前筛选。
 *
 * 「定时保活是否纳入该平台」读渠道能力位（tokenRefresh || oauthLogin，
 * 与 scheduler.runKeepalive 的账号过滤同源），不在前端写死平台名单：
 * 写死必然随平台增加而漂移。未纳入的池标注「不参与定时保活」——
 * 它的空保活记录是设计使然而非故障，两种情形必须在 UI 上分开。
 */
import type { Account } from '../../shared/api/types';
import type { Channel } from '../../shared/api/channels';
import { formatDate, formatTime, platformIdLabel } from '../../shared/lib/format';
import { Chip } from '../../shared/ui';
import { keepaliveOf, keepalivePools, keepalivePoolOf } from './accountPacks';

/** 与 scheduler.runKeepalive 的账号过滤同口径：tokenRefresh || oauthLogin。 */
function isKeepaliveScanned(cap: Channel['capability'] | undefined): boolean {
  if (!cap) return false;
  return cap.tokenRefresh === true || cap.oauthLogin === true;
}

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
      <div className="py-3 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
        没有启用中的账号。
      </div>
    );
  }
  // 卡片只显示当前筛选涉及的池；汇总头始终是整池口径
  const visible = stats.filter((s) => rows.some((a) => a.enabled && keepalivePoolOf(a) === s.platform));
  const shown = visible.length ? visible : stats;
  return (
    <div className="flex flex-col gap-4 p-3">
      {shown.map((s) => {
        const scanned = isKeepaliveScanned(channelById[s.platform]?.capability);
        const members = rows.filter((a) => a.enabled && keepalivePoolOf(a) === s.platform);
        return (
          <div
            key={s.platform}
            className="overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--rg-border)' }}
          >
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]"
              style={{ background: 'var(--rg-surface-secondary)', color: 'var(--rg-text-secondary)' }}
            >
              <span className="text-[13px] font-medium" style={{ color: 'var(--rg-text-primary)' }}>
                {platformIdLabel(s.platform)}
              </span>
              <span>{s.accounts} 个启用账号</span>
              {scanned ? (
                s.never ? (
                  <Chip tone="danger" dot="dot-error">
                    纳入定时保活 · 从无记录
                  </Chip>
                ) : (
                  <Chip tone="ok" dot="dot-ok">
                    纳入定时保活
                  </Chip>
                )
              ) : (
                <Chip tone="neutral">不参与定时保活</Chip>
              )}
              {scanned && s.stale > 0 && (
                <Chip tone="warn" dot="dot-cool">
                  {s.stale} 个账号保活记录超过 26 小时
                </Chip>
              )}
              {s.failing > 0 && (
                <Chip tone="danger" dot="dot-error">
                  {s.failing} 个账号最近保活失败
                </Chip>
              )}
              {s.expiringSoon > 0 ? (
                <Chip tone="warn" dot="dot-cool">
                  {s.expiringSoon} 个账号 token 7 日内到期
                </Chip>
              ) : (
                <span>token 均 7 日以上</span>
              )}
              <span className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                池最近保活：{s.lastAtMs == null ? '无' : formatTime(new Date(s.lastAtMs).toISOString())}
              </span>
            </div>
            <table className="card-table table-fixed w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th col-account">账号</th>
                  <th className="th">最近选用</th>
                  <th className="th">最近签到</th>
                  <th className="th">签到结果</th>
                  <th className="th">最近保活</th>
                  <th className="th">保活结果</th>
                  <th className="th">token 到期</th>
                </tr>
              </thead>
              <tbody>
                {members.map((a) => {
                  const k = keepaliveOf(a);
                  return (
                    <tr key={a.id} className="row-hover">
                      <td className="td font-mono text-[12px] truncate" data-label="账号">
                        {a.label || a.id}
                      </td>
                      <td className="td font-mono text-[12px]" data-label="最近选用">
                        {formatTime(a.lastPickedAt)}
                      </td>
                      <td className="td font-mono text-[12px]" data-label="最近签到">
                        {formatTime(a.lastCheckinAt)}
                      </td>
                      <td className="td font-mono text-[12px]" data-label="签到结果">
                        {a.lastCheckinResult || '—'}
                      </td>
                      <td className="td font-mono text-[12px]" data-label="最近保活">
                        {a.lastKeepaliveAt ? formatTime(a.lastKeepaliveAt) : '—'}
                      </td>
                      <td
                        className="td font-mono text-[12px] truncate"
                        title={a.lastKeepaliveResult || undefined}
                        data-label="保活结果"
                      >
                        {a.lastKeepaliveResult || '—'}
                      </td>
                      <td
                        className="td font-mono text-[12px] truncate"
                        data-label="token 到期"
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
                      当前筛选下该池没有可显示的行（上方汇总仍为整池口径）。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        );
      })}
      <p className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
        「最近保活」只在定时保活扫描（每日 22:00 兜底轮 + 每 15 分钟临期扫描）执行时写入。
        未纳入扫描的平台（WorkBuddy / Qoder / ZCode）的空记录不代表故障 —— 它们的 token
        仍会在转发请求与每日签到前按需续期，只是不留保活痕迹。
      </p>
    </div>
  );
}
