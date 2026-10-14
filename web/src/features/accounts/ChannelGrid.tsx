/**
 * 渠道接入总览。
 *
 * 数据全部来自 `GET /v1/admin/channels`（后端由 platform/variant.js 派生），
 * 前端**不写死平台名单**；每条接入方式能不能点，由后端探测结果决定
 * （本机客户端在不在、登录没登录），不可用时给出「需要装什么」而不是静默禁用。
 *
 * 组件只负责展示与派发：点「接入」把向导种类交给父级（CredentialsPage 统一持有
 * 各弹窗的开关状态，避免同一个弹窗被实例化两次）。
 *
 * 降级：后端新增了平台而前端还没做向导时，卡片显示「暂无接入向导」并说明
 * 该走哪个 API——不会白屏、不会静默消失。ZCode 当初的状态正是「后端就绪、
 * 前端一个按钮都没有」，且没有任何地方提示过。
 */
import type { Channel, ChannelsResponse } from '../../shared/api/channels';
import type { WizardKind } from '../../shared/lib/channels';
import { channelEntry, wizardFor } from '../../shared/lib/channels';
import type { AsyncState } from '../../shared/hooks/useAsyncData';
import { Button, Chip, EmptyState, ErrorState, LoadingBlock, Note } from '../../shared/ui';
import { formatNumber } from '../../shared/lib/format';

/** 能力位 → 展示标签。只列对用户有意义的位，不把 capability 原样铺开。 */
const CAPABILITY_TAGS: { key: keyof Channel['capability']; label: string }[] = [
  { key: 'chat', label: '对话转发' },
  { key: 'checkin', label: '每日签到' },
  { key: 'growth', label: '成长任务' },
  { key: 'rewardClaim', label: '活动领取' },
  // 一次性奖励与「每日活动领取」是两件事（Raccoon 的每日 300 没有端点，
  // 能领的只有每号一次的桌面端登录奖励），故分开标注。
  { key: 'loginReward', label: '登录奖励' },
  { key: 'oauthLogin', label: 'OAuth 登录' },
  { key: 'tokenRefresh', label: '自动续期' },
];

export function ChannelGrid({
  channels,
  onWizard,
  onOps,
  onReload,
}: {
  channels: AsyncState<ChannelsResponse>;
  /** 打开接入向导（按注册表解析出的向导种类） */
  onWizard: (kind: WizardKind, channelId: string) => void;
  /** 打开运营面（套餐 / 积分领取） */
  onOps: (channel: Channel) => void;
  /** 重新拉取渠道清单与账号列表 */
  onReload: () => void;
}) {
  if (channels.error) {
    return <ErrorState message={channels.error} onRetry={channels.reload} />;
  }
  if (channels.loading && !channels.data) {
    return <LoadingBlock label="正在读取渠道与台机器上的客户端状态" />;
  }
  const list = channels.data?.data ?? [];
  if (!list.length) {
    // 空态几乎只可能是后端异常（渠道表是常量），如实说明而不是假装"还没有渠道"
    return (
      <EmptyState
        label="后端没有返回任何渠道。"
        hint="渠道清单由 src/platform/variant.js 定义；若此处为空，说明该接口异常，请查看服务端日志。"
        action={{ label: '重新读取', onClick: channels.reload }}
      />
    );
  }

  const summary = channels.data?.summary;

  return (
    <div className="flex flex-col gap-3">
      {summary && (
        <div className="flex items-center gap-3 flex-wrap text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          <span>
            已接入 <strong style={{ color: 'var(--rg-text-primary)' }}>{summary.connected}</strong> / {summary.channels} 个渠道
          </span>
          <span>
            账号 <strong style={{ color: 'var(--rg-text-primary)' }}>{formatNumber(summary.accounts)}</strong> 个（已启用{' '}
            {formatNumber(summary.enabled)}）
          </span>
          <Button size="sm" onClick={onReload}>
            重新探测
          </Button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {list.map((c) => (
          <ChannelCard key={c.id} channel={c} onWizard={onWizard} onOps={onOps} />
        ))}
      </div>
    </div>
  );
}

function ChannelCard({
  channel,
  onWizard,
  onOps,
}: {
  channel: Channel;
  onWizard: (kind: WizardKind, channelId: string) => void;
  onOps: (channel: Channel) => void;
}) {
  const entry = channelEntry(channel.id);
  // 口径是「库里有该渠道的账号」而不是「有已启用的账号」：
  // WorkBuddy 导入后显式 enabled=false，按 enabled 判定会把刚导入完的渠道
  // 显示成「待接入」，与用户刚做完的操作直接矛盾。
  const connected = channel.accounts.total > 0;
  const tags = CAPABILITY_TAGS.filter((t) => channel.capability[t.key] === true);

  return (
    <div
      className="rounded-lg border p-3.5 min-w-0 flex flex-col gap-2.5"
      style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="shrink-0 grid place-items-center w-9 h-9 rounded-md text-[13px] font-semibold"
          style={{
            background: 'var(--rg-bg-base)',
            border: '1px solid var(--rg-border)',
            color: entry?.accent ?? 'var(--rg-text-secondary)',
          }}
          aria-hidden="true"
        >
          {channel.label.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate" title={channel.label}>
            {channel.label}
          </div>
          <div className="text-[11px] mt-0.5">
            {connected ? (
              <Chip tone="ok" dot="dot-ok">
                已接入
              </Chip>
            ) : (
              <Chip tone="neutral">待接入</Chip>
            )}
          </div>
        </div>
      </div>

      {channel.note && (
        <p className="text-[11px] leading-relaxed m-0" style={{ color: 'var(--rg-text-tertiary)' }}>
          {channel.note}
        </p>
      )}

      <div className="text-[11px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--rg-text-tertiary)' }}>
        <span>
          账号 <strong style={{ color: 'var(--rg-text-primary)' }}>{channel.accounts.total}</strong>
          {channel.accounts.total > 0 && `（启用 ${channel.accounts.enabled}）`}
        </span>
        {channel.accounts.cooling > 0 && <span style={{ color: 'var(--rg-state-warning)' }}>冷却 {channel.accounts.cooling}</span>}
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {tags.map((t) => (
            <Chip key={t.key}>{t.label}</Chip>
          ))}
        </div>
      )}

      {/* 接入方式：每条都是后端声明 + 本机实测的结果，可点性据此决定 */}
      <div className="flex flex-col gap-1.5 mt-auto">
        {entry === null ? (
          <Note tone="warn">
            此渠道暂无接入向导。后端接口已就绪，可先用 API 接入（见 docs/ 对应平台说明），
            或等待面板补齐。
          </Note>
        ) : (
          channel.onboarding.map((o) => {
            const kind = wizardFor(channel.id, o.kind);
            return (
              <div key={o.kind} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={o.available ? 'primary' : 'default'}
                    disabled={!o.available || kind === null}
                    onClick={() => kind && onWizard(kind, channel.id)}
                    title={o.available ? o.label : o.detail}
                  >
                    {o.label}
                  </Button>
                  {!o.available && (
                    <span className="text-[11px] min-w-0 flex-1" style={{ color: 'var(--rg-text-tertiary)' }}>
                      不可用
                    </span>
                  )}
                </div>
                {o.detail && (
                  <span
                    className="text-[11px] leading-snug break-all"
                    style={{ color: o.available ? 'var(--rg-text-tertiary)' : 'var(--rg-state-warning)' }}
                  >
                    {o.detail}
                  </span>
                )}
              </div>
            );
          })
        )}

        {/* 运营面：能力位来自后端，前端不按渠道名硬编码 */}
        {channel.capability.rewardClaim === true && (
          <Button size="sm" onClick={() => onOps(channel)} disabled={!connected}>
            {connected ? '套餐 / 活动领取' : '接入账号后可领取'}
          </Button>
        )}
      </div>
    </div>
  );
}
