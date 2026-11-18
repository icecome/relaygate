/**
 * 基础 UI 组件（无业务语义）。
 * 只负责结构与可访问性，不发起请求、不含业务判断。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';

/* Button */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', VARIANT_CLASS[variant], size === 'sm' ? 'btn-sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}

/* Field */

/**
 * 单输入框 + 可选标签。
 *
 * 刻意在类型上排除 children：input 是 void 元素，传入 children 会被 React
 * 判为「void 元素带 children」并在渲染期抛错（对应压缩错误 #137）。
 * 需要「时:分」这类组合控件时用 FieldRow。
 *
 * id 必须兜底生成：调用方几乎都只传 label，不传 id；此时若直接
 * htmlFor={undefined}，可见标签与输入框之间没有任何关联，点击标签不聚焦、
 * 读屏也不播报字段名。useId 提供稳定且唯一的 id，调用方传 id 时仍然优先用它。
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {
  label?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, id, className = '', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={['field', 'w-full', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
  // 无 label 时不渲染 <label>，此时 id 仍挂上，便于外部 aria-labelledby 引用
  if (!label) return input;
  return (
    <label className="flex flex-col gap-1 min-w-0" htmlFor={inputId}>
      <span className="text-aux fg-2">
        {label}
      </span>
      {input}
    </label>
  );
});

/**
 * 带标签的表单行，接受任意 children。
 * 用于「时:分」这类需要多个输入框或组合控件的场景。
 */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-aux fg-2">
        {label}
      </span>
      {children}
    </div>
  );
}

/* Stepper */

/**
 * 紧凑整数步进器。用于表格单元格等空间受限处：
 * - 高度 h-6，比 .field（h-8）小一号，嵌入表格不突兀
 * - 两侧 ± 微调，中间可直接键入目标值
 * - 隐藏 number input 的原生 spinners（见 global.css 的 .stepper-input），
 *   否则会与两侧按钮重复且撑高行高
 */
export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** 无障碍标签（该控件无可见文字时必须提供） */
  label: string;
  onChange: (next: number) => void;
}

export function Stepper({
  value,
  min = 0,
  max = 99,
  step = 1,
  disabled,
  label,
  onChange,
}: StepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const nudge = (delta: number) => {
    if (disabled) return;
    const next = clamp(value + delta);
    if (next !== value) onChange(next);
  };
  return (
    <div
      className="stepper inline-flex items-stretch h-6 rounded-md border overflow-hidden"
      style={{ borderColor: 'var(--rg-border-stronger)', background: 'var(--rg-bg-base)' }}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="stepper-btn px-1.5 text-[13px] leading-none disabled:opacity-40 fg-2"
        disabled={disabled || value <= min}
        aria-label={`${label}：减少`}
        onClick={() => nudge(-step)}
      >
        −
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const raw = Number.parseInt(e.target.value, 10);
          if (!Number.isFinite(raw)) return;
          const next = clamp(raw);
          if (next !== value) onChange(next);
        }}
        className="stepper-input w-[34px] border-0 text-center text-aux font-mono p-0 fg-1"
        style={{ background: 'transparent' }}
      />
      <button
        type="button"
        className="stepper-btn px-1.5 text-[13px] leading-none disabled:opacity-40 fg-2"
        disabled={disabled || value >= max}
        aria-label={`${label}：增加`}
        onClick={() => nudge(step)}
      >
        +
      </button>
    </div>
  );
}

/* NumberField */

/**
 * 定宽数字输入。
 *
 * ## 为什么不是 Field + props
 *
 * `Field` 强制 `w-full`（它的设计场景是表单主体，标签在上、输入框铺满）。
 * 而这些场景全是「工具条里一个 56px 的格子」：定时任务的小时、分钟、
 * 轮转池大小、探测间隔。硬套 Field 就得再写 `style={{ width: 56 }}`，
 * 那正是此前三处独立实现各自绕开 Field 的原因 ——
 * QoderOps.NumInput、ZcodeOps.HourInput / MinuteInput、OpsPage 的裸 input。
 *
 * ## 为什么 height 用 .field 而宽度内联
 *
 * 高度是控件基线（32px），必须与 .btn / .select / .seg-item 一致；
 * 宽度是布局量，随场景变化（两位数是 56px，三位数是 72px）。
 * 把高度做成类、宽度做成 props，是这两者唯一合理的分工。
 *
 * 宽度只能内联：取值来自 props（运行时才知道），Tailwind 无法为
 * 动态拼出的 `w-[${width}px]` 生成类。这是 styleBlocks 规则允许的内联类型。
 */
export function NumberField({
  value,
  min = 0,
  max = 99,
  step = 1,
  width = 56,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** 像素宽。默认 56 够放两位数字加内边距；三位数场景传 72 */
  width?: number;
  /** 无障碍名，必填：这些控件没有可见标签 */
  label: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <input
      type="number"
      className="field font-mono text-aux text-center"
      style={{ width }}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        const raw = Number.parseInt(e.target.value, 10);
        // 空串（用户全选删除）不当作 0：保持原值，等用户输入下一位
        if (!Number.isFinite(raw)) return;
        const next = Math.max(min, Math.min(max, raw));
        if (next !== value) onChange(next);
      }}
    />
  );
}

/* TimeOfDay */

/**
 * 「时:分」组合。
 *
 * 此前同一个语义存在三套实现：
 *   QoderOps.NumInput                       —— 通用数字框，靠调用方传 max
 *   ZcodeOps.HourInput + MinuteInput        —— 两个几乎相同的函数
 *   OpsPage 的 FieldRow + 两个裸 input      —— 6 组各写一遍、各带一次内联
 *
 * 三者的差异只有 min/max 与 aria-label，却因此产生了三处需要同步维护的
 * 边界处理（clamp 逻辑）与三个不同的可访问名风格（「时」「分」vs 无）。
 *
 * 语义在这里定死：两个输入各有独立标签，前缀是业务名
 * （「每日签到：时」而不是「时」），读屏才知道这个格子在填什么。
 */
export function TimeOfDay({
  hour,
  minute,
  label,
  disabled,
  onChange,
}: {
  hour: number;
  minute: number;
  /** 业务名，例如「每日签到」「账号轮换时刻」 */
  label: string;
  disabled?: boolean;
  onChange: (next: { hour: number; minute: number }) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <NumberField
        value={hour}
        min={0}
        max={23}
        width={56}
        label={`${label}：时`}
        disabled={disabled}
        onChange={(h) => onChange({ hour: h, minute })}
      />
      <span className="font-mono text-aux fg-2" aria-hidden="true">
        :
      </span>
      <NumberField
        value={minute}
        min={0}
        max={59}
        width={56}
        label={`${label}：分`}
        disabled={disabled}
        onChange={(m) => onChange({ hour, minute: m })}
      />
    </span>
  );
}

/* Panel */

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 内容区去掉内边距，供表格贴边铺满 */
  flush?: boolean;
  footer?: ReactNode;
  /**
   * 面板根节点的 id，供面板外的控件用 `aria-controls` 指向它。
   *
   * 典型场景：工具栏上的「展开/收起权益总览」按钮在面板**外部**，
   * 它需要一个可解析的目标，否则 `aria-controls` 指向不存在的 id，
   * 读屏播报不到被控制的区域（Chrome 会把整个 aria-controls 忽略掉）。
   */
  id?: string;
}

export function Panel({ id, title, description, actions, children, flush, footer }: PanelProps) {
  return (
    <section className="panel" id={id}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="min-w-0">
            {title && <h2 className="panel-title">{title}</h2>}
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {actions && <div className="right">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body-flush' : 'panel-body'}>{children}</div>
      {footer && <footer className="panel-foot text-aux">{footer}</footer>}
    </section>
  );
}

/* MetricGrid */

export interface Metric {
  key: string;
  value: ReactNode;
  delta?: ReactNode;
}

export function MetricGrid({ items }: { items: Metric[] }) {
  // 项数写进 data-cols：4 项以内按实际数量铺满，避免四列里空一片
  const cols = Math.min(Math.max(items.length, 1), 4);
  return (
    <div className="metric-grid" data-cols={cols}>
      {items.map((m) => (
        <div key={m.key} className="metric-cell">
          <div className="metric-key">{m.key}</div>
          <div className="text-read mt-1.5">{m.value}</div>
          {m.delta && <div className="metric-delta">{m.delta}</div>}
        </div>
      ))}
    </div>
  );
}

/* StateChip */

/**
 * 状态色调。五档业务状态 + 一档中性。
 *
 * 为什么需要 info 而不是复用 brand：brand 表达「这是品牌强调」—— 来源标记、
 * 层级标识、当前选中项；info 表达「这件事正在发生」—— 进行中、排队中、
 * 同步中。此前这两种语义共用 brand，于是「进行中」和「来源：手动导入」
 * 在界面上完全同形，用户无法从颜色读出区别。
 *
 * 令牌 --rg-state-info 早已定义（含 12% 淡底），但零引用 —— 这一档是它的出口。
 */
export type ChipTone = 'neutral' | 'brand' | 'info' | 'ok' | 'warn' | 'danger';

const CHIP_CLASS: Record<ChipTone, string> = {
  neutral: 'pill',
  brand: 'pill pill-brand',
  info: 'pill pill-info',
  ok: 'pill pill-ok',
  warn: 'pill pill-warn',
  danger: 'pill pill-danger',
};

export interface ChipProps {
  tone?: ChipTone;
  /** 状态方点，颜色需与 tone 语义一致 */
  dot?: string;
  /**
   * 悬停说明。保活这类「一个词背后有三种语义」的 chip 必须能带理由，
   * 否则「无需保活」与「不保活」在界面上只是两个猜不出差别的短语。
   */
  title?: string;
  children: ReactNode;
}

export function Chip({ tone = 'neutral', dot, title, children }: ChipProps) {
  return (
    <span className={CHIP_CLASS[tone]} title={title}>
      {dot && <i className={`dot ${dot}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* Segmented */

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /**
   * 语义档位。
   *
   *   tabs   = 切换内容面板（role=tablist / role=tab，选中项 aria-selected）
   *   filter = 过滤当前列表（role=group，选中项 aria-pressed）
   *
   * 默认 filter：全库 17 处调用点里 16 处是筛选 —— 选完只是过滤当前表格，
   * 屏幕上的内容面板没有切换。剩下 1 处是 OpsPage 的运维分区（回调里
   * 调 navigate 跳到另一条路由），它必须显式传 tabs。
   *
   * 反过来设默认（tabs）会让 16 处筛选控件被读屏播报成「选项卡 2/4，
   * 已选中」，而按 Tab 键时用户会期待焦点进入一个新面板 —— 那个面板不存在。
   *
   * 两档的视觉完全一致（.seg-item 同时匹配 aria-selected 与 aria-pressed），
   * 只有无障碍语义不同。同一个控件在不同语义下不该长得不一样。
   */
  variant?: 'tabs' | 'filter';
}

/** 分段控件。用于筛选与页内分区。 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = 'filter',
}: SegmentedProps<T>) {
  if (variant === 'tabs') {
    return (
      <div className="seg" role="tablist" aria-label={ariaLabel}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            className="seg-item"
            aria-selected={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg-item"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* KeyValue */

export interface KeyValueRow {
  k: string;
  v: ReactNode;
  /** 密排时占满整行，用于长 URL 等不宜被压窄的内容。 */
  wide?: boolean;
}

export function KeyValue({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="kv">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* KeyCards */

/**
 * 逐字段卡片。适合字段少、彼此独立且需要横向扫读的运行态指标。
 * 语义相近的一组字段请改用 KeyCardGroups。
 *
 * 列数交给 auto-fit：调用方只知道「大致想要几列」，实际可用宽度由容器决定。
 * 传死列数会在窄容器里把每卡压到 100px 以内，字段名全部折行。
 */
export function KeyCards({ cols = 3, rows }: { cols?: number; rows: KeyValueRow[] }) {
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${Math.max(150, 900 / cols)}px, 1fr))` }}
    >
      {rows.map((r) => (
        <div key={r.k} className="subcard-soft px-3.5 py-2.5">
          <div className="text-aux fg-3">
            {r.k}
          </div>
          <div className="mt-1 text-[15px] font-medium break-words">{r.v}</div>
        </div>
      ))}
    </div>
  );
}

export interface KeyCardGroup {
  /** 分组标题 */
  title: string;
  rows: KeyValueRow[];
}

/** 超过该字段数的分组在卡内分两列排布，避免单卡高度明显高出同排卡片。 */
const DENSE_ROW_THRESHOLD = 6;

/**
 * 分组卡片：一个语义分组一张卡，字段以无边框紧凑行排列在卡内。
 * 卡面沿用面板底色，仅用描边区分层级，避免在白色面板内再压一层灰底。
 * 外层两列（容器窄时自动降一列）；同一行卡片等高。
 */
export function KeyCardGroups({ groups }: { groups: KeyCardGroup[] }) {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      {groups.map((g) => {
        const dense = g.rows.length > DENSE_ROW_THRESHOLD;
        return (
          <div key={g.title} className="subcard px-3.5">
            <div className="mb-1.5 card-head">
              <span className="text-aux font-medium fg-2">
                {g.title}
              </span>
              <span className="card-head-line" />
            </div>
            <dl
              className={dense ? 'grid gap-x-4 grid-cols-2' : 'flex flex-col'}
              style={dense ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } : undefined}
            >
              {g.rows.map((r) => (
                <div
                  key={r.k}
                  className={
                    dense && r.wide
                      ? 'kv-compact col-span-2'
                      : 'kv-compact'
                  }
                  style={{ gridTemplateColumns: dense ? '88px minmax(0, 1fr)' : '132px minmax(0, 1fr)' }}
                >
                  <dt className="text-aux leading-[1.5] fg-3">
                    {r.k}
                  </dt>
                  <dd className="m-0 text-[13px] leading-[1.5] break-words">{r.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

/* Note */

export function Note({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const cls = tone === 'neutral' ? 'note' : `note note-${tone}`;
  return (
    <div className={cls} role={tone === 'neutral' ? undefined : 'alert'}>
      {children}
    </div>
  );
}

/* ProgressBar */

export function ProgressBar({
  ratio,
  tone = 'brand',
}: {
  /** 0-1，超出范围会被夹紧 */
  ratio: number;
  tone?: 'brand' | 'soft' | 'warn' | 'danger';
}) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const toneClass = tone === 'brand' ? '' : `bar-${tone}`;
  return (
    <div className={`bar ${toneClass}`} role="presentation">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/* Loading / Empty */

/**
 * 加载态。
 *
 * 省略号由组件统一追加，调用方传「加载模块」而不是「加载模块…」——
 * 否则会渲染成「加载模块……」。这一点此前被 App.tsx 踩到过。
 */
export function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="p-4 text-aux fg-3" role="status">
      {label.replace(/…+$/, '')}…
    </div>
  );
}

/** 空态与错误态里「标签式」短句统一不带句末句号，这里做一次兜底收敛。 */
function stripTrailingPeriod(text: string): string {
  return text.replace(/。\s*$/, '');
}

/**
 * 空态。回答两个问题：为什么空、现在该做什么。
 * 只有纯展示的空态可以省略 action，但 hint 至少要说明原因，
 * 否则用户停在空页面时无法判断是「还没配」还是「筛错了」。
 */
export function EmptyState({
  label,
  hint,
  action,
}: {
  label: string;
  /** 原因说明，例如「官方账单通常在请求后 1 至 2 天出现」 */
  hint?: string;
  /** 下一步动作，例如「接入第一个账号」 */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="p-4 text-aux flex flex-col items-start gap-2 fg-3">
      <div>{stripTrailingPeriod(label)}</div>
      {hint && (
        <div className="text-aux leading-relaxed fg-3">
          {hint}
        </div>
      )}
      {action && (
        <Button size="sm" variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** 错误态。区分传输失败与业务失败，避免把业务原因说成网络错误。 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note note-danger" role="alert">
      <div className="flex-1 min-w-0">{message}</div>
      {onRetry && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}