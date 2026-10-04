import type { AccountState } from '../api/types';

/**
 * 状态灯：以「圆点 + 文字」表达账号状态，替代原先的彩色胶囊。
 *
 * 设计依据（设计稿 v2 区块 04）：
 * 一屏十几行账号若每行都顶一个彩色胶囊，健康账号会与异常账号争抢同样的注意力。
 * 这里让**健康态退回中性灰**——它本来就该是安静的；只有冷却与停用才着色，
 * 使视线自动落到需要处理的行上。
 */

/** 圆点配色：ok 用中性灰（安静），异常才着色 */
const DOT: Record<AccountState, string> = {
  ok: 'bg-[#A6AFBC]',
  cool: 'bg-warn',
  off: 'bg-danger',
};

const LABEL: Record<AccountState, string> = {
  ok: '正常',
  cool: '冷却中',
  off: '已停用',
};

/** 文字配色：ok/off 保持常规墨色，cool 用警示色以便一行内快速定位 */
const TEXT: Record<AccountState, string> = {
  ok: 'text-ink-soft',
  cool: 'text-warn',
  off: 'text-ink-soft',
};

export interface StatusDotProps {
  state: AccountState;
  /** 覆盖默认文案，例如「冷却中 · 剩余 03:42」 */
  label?: string;
  /** 附加在文案下方的次要说明（如冷却到期时间） */
  hint?: string;
}

export default function StatusDot({ state, label, hint }: StatusDotProps) {
  return (
    <span className="inline-flex items-start gap-2">
      <span
        className={`w-[7px] h-[7px] rounded-full shrink-0 mt-[6px] ${DOT[state]}`}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className={`block text-[12.5px] leading-[1.4] ${TEXT[state]}`}>{label ?? LABEL[state]}</span>
        {hint ? <span className="block text-[11px] text-ink-faint leading-[1.4] mt-0.5">{hint}</span> : null}
      </span>
    </span>
  );
}
