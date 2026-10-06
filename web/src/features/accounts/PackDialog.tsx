/**
 * 账号权益包弹窗：展示单个账号的全部权益包。
 * 由账号表「到期」列点击触发，替代行内展开，避免表格结构被撑高。
 */
import type { Account } from '../../shared/api/types';
import Modal from '../../shared/ui/Modal';
import { Chip } from '../../shared/ui';
import { accountState, STATE_DOT_CLASS, STATE_LABEL } from '../../shared/lib/format';
import { PackTable, worstExpiry } from './accountPacks';

export function PackDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  if (!account) return null;

  const st = accountState(account);
  const worst = worstExpiry(account);

  return (
    <Modal
      open
      onClose={onClose}
      title={`权益包 · ${account.label || account.id}`}
      size="lg"
      footer="已用尽或已过期的权益包不参与调度。"
    >
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <Chip tone="neutral" dot={STATE_DOT_CLASS[st]}>
          {STATE_LABEL[st]}
        </Chip>
        <span className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          {account.id}
        </span>
        {account.source || account.edition ? (
          <span className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
            {account.source || account.edition}
          </span>
        ) : null}
      </div>

      {worst?.urgency && (
        <div className="mb-3">
          <div
            className="rounded-md px-3 py-2 text-[12px]"
            style={{
              background:
                worst.urgency === 'expired'
                  ? 'var(--rg-state-error-surface)'
                  : 'var(--rg-state-warning-surface)',
              color:
                worst.urgency === 'expired'
                  ? 'var(--rg-state-error)'
                  : 'var(--rg-state-warning)',
            }}
          >
            {worst.urgency === 'expired'
              ? '存在已到期的权益包，请尽快处理'
              : `最近的一项将在 ${worst.days} 天后到期`}
          </div>
        </div>
      )}

      <PackTable account={account} />
    </Modal>
  );
}