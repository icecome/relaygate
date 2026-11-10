/**
 * 平台接入条。
 *
 * 替代原来的四列卡片网格（`ChannelGrid.tsx`）。原实现的问题有实测依据：
 *   - 网格等高，行高被最高的一张卡通吃：WorkBuddy 卡 ≈542px（3 条接入方式、
 *     detail 合计 284 字符），而 ZCode 卡 ≈250px —— 同排卡片下方各留 290px 死白；
 *   - 三层解释文字常驻（面板说明 + 平台自述 note + 逐条探测 detail），
 *     其中 WorkBuddy 的单条 detail 就 109 字符，用 break-all 全量铺在按钮下方；
 *   - 7 类能力位 Chip × 5 卡 = 最多 35 枚，其中「OAuth 登录」「自动续期」
 *     是内部机制词，其余 5 类在别处已有更强的表达（行内按钮 / 成长中心）；
 *   - 「不可用」三字在禁用按钮旁重复一次，零信息量。
 * 合计让渠道区吃掉 ≈640–700px 首屏高度，凭据表在 1440×900 下首屏不可见。
 *
 * 现在的形态：一条 56px 的横向 rail，每段 = 平台名 + 账号计数 + 一个主按钮
 * + 一个「⋯」菜单。次要与不可用项进菜单，长文案进 title。
 *
 * 数据契约不变（不强加新约束）：
 *   - 平台名单与能力位仍全部来自 GET /v1/admin/channels（后端 variant.js），
 *     前端不写死平台名单；
 *   - 主按钮取 `onboarding` 里**第一条 available 的**，不按平台名硬编码——
 *     WorkBuddy 的 local 实测不可用（客户端凭据已加密），过滤后 paste 自然胜出；
 *   - 一条向导都没注册的渠道显示「暂无接入入口」而不是白屏。
 */
import type { Channel, ChannelsResponse } from '../../shared/api/channels';
import type { WizardKind } from '../../shared/lib/channels';
import { channelEntry, wizardFor } from '../../shared/lib/channels';
import type { AsyncState } from '../../shared/hooks/useAsyncData';
import { Button, EmptyState, ErrorState, LoadingBlock } from '../../shared/ui';
import { MenuButton, type MenuItem } from '../../shared/ui/Menu';
import { formatNumber } from '../../shared/lib/format';

export function ChannelRail({
  channels,
  onWizard,
  onOps,
  onDetail,
  onReload,
}: {
  channels: AsyncState<ChannelsResponse>;
  onWizard: (kind: WizardKind, channelId: string) => void;
  onOps: (channel: Channel) => void;
  /** 打开该平台的接入详情（本机探测全文、能力位、定时任务快照） */
  onDetail: (channel: Channel) => void;
  onReload: () => void;
}) {
  if (channels.error) {
    return <ErrorState message={channels.error} onRetry={channels.reload} />;
  }
  if (channels.loading && !channels.data) {
    return <LoadingBlock label="读取平台信息" />;
  }
  const list = channels.data?.data ?? [];
  if (!list.length) {
    return (
      <EmptyState
        label="没有读到任何平台"
        hint="平台清单由服务端下发；为空说明该接口异常，请查看服务端日志后重试。"
        action={{ label: '重新读取', onClick: channels.reload }}
      />
    );
  }

  return (
    <div className="rail" role="list">
      {list.map((c) => (
        <ChannelSegment
          key={c.id}
          channel={c}
          onWizard={onWizard}
          onOps={onOps}
          onDetail={onDetail}
        />
      ))}
      <div className="rail-tail">
        <Button size="sm" variant="ghost" onClick={onReload} title="重新探测本机客户端与账号计数">
          重新探测
        </Button>
      </div>
    </div>
  );
}

/** 首字母色块的字（1 个字符即可，原实现截两个字母如「WO」并不好认）。 */
function initialsOf(label: string): string {
  return label.slice(0, 1).toUpperCase();
}

function ChannelSegment({
  channel,
  onWizard,
  onOps,
  onDetail,
}: {
  channel: Channel;
  onWizard: (kind: WizardKind, channelId: string) => void;
  onOps: (channel: Channel) => void;
  onDetail: (channel: Channel) => void;
}) {
  const entry = channelEntry(channel.id);
  // 「已接入」口径是库里有该平台的账号（total > 0），不是 enabled > 0：
  // WorkBuddy 导入后显式 enabled=false，按 enabled 判定会把刚导入完的渠道
  // 显示成「待接入」，与用户刚做完的操作直接矛盾。
  const connected = channel.accounts.total > 0;
  const { total, enabled, cooling } = channel.accounts;

  // 主按钮：第一条可用且有向导落点的接入方式。
  // 不按平台名硬编码 —— 后端 onboarding 顺序已表达优先级，
  // 且可用性由本机探测决定（WorkBuddy 的 local 实测不可用）。
  const primary = channel.onboarding.find((o) => {
    const kind = wizardFor(channel.id, o.kind);
    return o.available && kind !== null;
  });
  const primaryKind = primary ? wizardFor(channel.id, primary.kind) : null;

  // 菜单项：其余接入方式 + 运营面 + 详情
  const moreItems: MenuItem[] = channel.onboarding
    .filter((o) => o !== primary)
    .map((o) => {
      const kind = wizardFor(channel.id, o.kind);
      const unavailable = !o.available || kind === null;
      return {
        key: `onb-${o.kind}`,
        label: unavailable ? `${o.label}（不可用）` : o.label,
        disabled: unavailable,
        // 完整原因进 title：原实现是 break-all 常驻铺在卡片里
        hint: unavailable ? o.detail || '本机未就绪' : o.detail || undefined,
        onSelect: () => {
          if (kind) onWizard(kind, channel.id);
        },
      };
    });

  if (!entry) {
    moreItems.push({
      key: 'no-wizard',
      label: '暂无接入向导',
      disabled: true,
      hint: '该平台后端已就绪，前端向导尚未实现；可先用 API 接入',
    });
  }

  if (channel.capability.rewardClaim === true) {
    moreItems.push({
      key: 'ops',
      label: '套餐 / 活动领取',
      disabled: !connected,
      hint: connected ? '探测并领取上游赠送额度' : '需先接入该平台的账号',
      groupStart: moreItems.length > 0,
      onSelect: () => onOps(channel),
    });
  }

  moreItems.push({
    key: 'detail',
    label: '平台详情',
    groupStart: true,
    hint: '本机探测结果、能力清单、定时任务',
    onSelect: () => onDetail(channel),
  });

  return (
    <div
      className="rail-item"
      role="listitem"
      data-connected={connected ? 'on' : 'off'}
      aria-label={`${channel.label}，${connected ? `已接入 ${total} 个账号` : '待接入'}`}
    >
      <span className="rail-badge" aria-hidden="true" style={{ color: entry?.accent ?? 'var(--rg-text-secondary)' }}>
        {initialsOf(channel.label)}
      </span>
      <div className="rail-main">
        <span className="rail-name">{channel.label}</span>
        <span className="rail-meta">
          {connected ? (
            <>
              {formatNumber(total)} 个账号
              {enabled !== total && ` · ${formatNumber(enabled)} 启用`}
              {cooling > 0 && (
                <span style={{ color: 'var(--rg-state-warning)' }}> · 冷却 {cooling}</span>
              )}
            </>
          ) : (
            '待接入'
          )}
        </span>
      </div>
      <div className="rail-acts">
        {primaryKind ? (
          <Button
            size="sm"
            variant={connected ? 'default' : 'primary'}
            onClick={() => onWizard(primaryKind, channel.id)}
            title={primary?.detail || primary?.label}
          >
            {connected ? '添加' : '接入'}
          </Button>
        ) : (
          <Button size="sm" disabled title="此平台暂无可用接入向导">
            接入
          </Button>
        )}
        <MenuButton
          label={`${channel.label} 的更多操作`}
          items={moreItems}
          width={210}
        />
      </div>
    </div>
  );
}
