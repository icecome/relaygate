/**
 * 渠道运营面弹窗：上游赠送额度的探测与领取。
 *
 * 准入判据只有一条——后端能力位 `capability.rewardClaim === true`。
 * 前端**不按渠道名硬编码**该给谁运营面：新增带运营面的平台时只要在
 * `variant.js` 声明能力位，卡片上的入口会自动出现；而这里没实现的面板会
 * 落到兜底分支显式说明，不会静默什么都不显示。
 */
import type { Channel } from '../../shared/api/channels';
import { Button, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { QoderOps } from './QoderOps';
import { ZcodeOps } from './ZcodeOps';

export function ChannelOpsDialog({
  channel,
  onClose,
  onChanged,
}: {
  /** null 表示弹窗关闭 */
  channel: Channel | null;
  onClose: () => void;
  /** 写操作完成后刷新渠道清单与账号列表（计数、快照都会变） */
  onChanged: () => void;
}) {
  if (!channel) return null;

  const body =
    channel.id === 'zcode' ? (
      <ZcodeOps jobs={channel.jobs} onChanged={onChanged} />
    ) : channel.id === 'qoder' ? (
      <QoderOps jobs={channel.jobs} onChanged={onChanged} />
    ) : (
      <Note tone="warn">
        该渠道声明了活动领取能力，但面板还没有对应的操作界面。请先用 API
        操作（见 <code>docs/</code> 下该平台的接入说明）。
      </Note>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={`${channel.label} 运营面`}
      desc="探测并领取上游赠送额度；这里的操作会真实请求上游"
      size="xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {body}
    </Modal>
  );
}
