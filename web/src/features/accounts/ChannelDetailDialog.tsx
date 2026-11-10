/**
 * 平台接入详情弹窗。
 *
 * 「首页最小化、详情跳转」的落点之一：rail 上每段只留「接入 / 添加」+ ⋯，
 * 探测全文（本机路径、加密说明、可用性原因）、完整能力清单、运营面定时任务
 * 快照全部收进这里。原来这些文字被 break-all 全量铺在卡片里，WorkBuddy
 * 单条 detail 就 109 字符。
 *
 * 数据来源：`/v1/admin/channels` 已经在手（父级传进来的 channel 对象），
 * 所以这个弹窗**不发任何请求**，纯展示。
 */
import type { Channel } from '../../shared/api/channels';
import { Button, Chip, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { channelEntry, wizardFor } from '../../shared/lib/channels';

/** 能力位 → 用户能读懂的标签。只列对用户有意义的位。 */
const CAPABILITY_LABEL: { key: keyof Channel['capability']; label: string; hint: string }[] = [
  { key: 'chat', label: '对话转发', hint: '该平台的账号可参与 /v1/chat/completions 调度' },
  { key: 'checkin', label: '每日签到', hint: '有可调用的签到端点，行内会出现「签到」按钮' },
  { key: 'growth', label: '成长任务', hint: '旅行 / 领奖 / 连登 / 抽奖，由后台定时任务执行' },
  { key: 'rewardClaim', label: '活动领取', hint: '限时套餐或每日积分活动，可在运营面手动触发' },
  { key: 'loginReward', label: '登录奖励', hint: '每个账号一次性的登录赠送' },
  { key: 'balance', label: '余额查询', hint: '可向上游查询剩余额度' },
  { key: 'billing', label: '用量账单', hint: '提供账单 / 用量明细接口' },
  { key: 'oauthOnboarding', label: 'OAuth 接入', hint: '支持通过授权页添加新账号' },
  { key: 'tokenRefresh', label: '自动续期', hint: '服务端会自动刷新即将过期的登录凭据' },
  { key: 'deviceFingerprint', label: '设备标识', hint: '可重置设备指纹（个别平台风控后需要）' },
  { key: 'localImport', label: '本机导入', hint: '可读取本机桌面客户端的登录态' },
  { key: 'dailyKeepalive', label: '每日保活', hint: '每天代做一次等价动作以延长额度有效期' },
];

export function ChannelDetailDialog({
  channel,
  onClose,
  onWizard,
}: {
  channel: Channel | null;
  onClose: () => void;
  onWizard: (kind: NonNullable<ReturnType<typeof wizardFor>>, channelId: string) => void;
}) {
  if (!channel) return null;

  const entry = channelEntry(channel.id);
  const caps = CAPABILITY_LABEL.filter((c) => channel.capability[c.key] === true);
  const connected = channel.accounts.total > 0;
  const jobs = channel.jobs;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${channel.label} 接入详情`}
      desc={connected ? `已接入 ${channel.accounts.total} 个账号` : '尚未接入账号'}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 接入方式：全部列出，含不可用的与原因 */}
        <section>
          <div className="text-label mb-2">接入方式</div>
          {entry === null ? (
            <Note tone="warn">
              该平台后端已就绪，但前端还没有对应的接入向导。可先用 API 接入，或等待面板补齐。
            </Note>
          ) : (
            <div className="flex flex-col gap-2">
              {channel.onboarding.map((o) => {
                const kind = wizardFor(channel.id, o.kind);
                const usable = o.available && kind !== null;
                return (
                  <div
                    key={o.kind}
                    className="flex items-start gap-3 rounded-md border px-3 py-2"
                    style={{ borderColor: 'var(--rg-border)' }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium">{o.label}</span>
                        {usable ? (
                          <Chip tone="ok" dot="dot-ok">可用</Chip>
                        ) : (
                          <Chip tone="warn">不可用</Chip>
                        )}
                      </div>
                      {o.detail && (
                        <p
                          className="m-0 mt-1 text-aux leading-relaxed"
                          style={{ color: usable ? 'var(--rg-text-tertiary)' : 'var(--rg-state-warning)' }}
                        >
                          {o.detail}
                        </p>
                      )}
                    </div>
                    {usable && kind && (
                      <Button size="sm" onClick={() => { onClose(); onWizard(kind, channel.id); }}>
                        开始
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 能力清单 */}
        <section>
          <div className="text-label mb-2">平台能力（共 {caps.length} 项）</div>
          {caps.length === 0 ? (
            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
              该平台没有声明任何能力位。
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {caps.map((c) => (
                <Chip key={c.key}>{c.label}</Chip>
              ))}
            </div>
          )}
          <p className="mt-2 text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
            能力位决定界面上会出现哪些按钮：例如只有声明了「每日签到」的平台，
            行内才有签到入口。这些声明来自服务端，前端不按平台名硬编码。
          </p>
        </section>

        {/* 运营面定时任务 */}
        {jobs && (
          <section>
            <div className="text-label mb-2">运营面定时任务</div>
            <dl className="kv">
              <dt>状态</dt>
              <dd>
                {jobs.enabled ? '已启用' : '已停用'}
                {jobs.autoClaim ? ' · 自动领取' : ' · 只探测不领取'}
              </dd>
              <dt>覆盖账号</dt>
              <dd>{formatNumber(jobs.accounts)} 个启用账号</dd>
              <dt>下次执行</dt>
              <dd className="td-mono">{jobs.nextRunAt ? formatTime(jobs.nextRunAt) : '未排程'}</dd>
              <dt>上次执行</dt>
              <dd className="td-mono">{jobs.lastRunAt ? formatTime(jobs.lastRunAt) : '尚未运行'}</dd>
              {jobs.solver && (
                <>
                  <dt>验证码求解</dt>
                  <dd>{jobs.solver.available ? '可用' : '不可用'}</dd>
                </>
              )}
              {jobs.lastError && (
                <>
                  <dt>上次错误</dt>
                  <dd style={{ color: 'var(--rg-state-error)' }}>{jobs.lastError}</dd>
                </>
              )}
            </dl>
            <p className="mt-2 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
              执行时刻可在「运维 → 定时任务」调整；这里只读。
            </p>
          </section>
        )}
      </div>
    </Modal>
  );
}
