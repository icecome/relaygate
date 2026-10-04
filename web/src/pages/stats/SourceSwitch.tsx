/**
 * 数据源切换：同一指标下的两个独立口径。
 * 与顶部子栏（栏目级导航）视觉区分开——这里切换的是「数据从哪来」，不是「看哪一栏」。
 * 用带前缀标签的描边按钮而非胶囊轨道，避免与栏目标签混淆。
 */
export interface SourceOption {
  id: string;
  label: string;
  /** 数据来源的一句话说明，直接展示在按钮下方，避免用户误读口径 */
  hint: string;
}

export default function SourceSwitch({
  options,
  value,
  onChange,
}: {
  options: SourceOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2" role="radiogroup" aria-label="数据源">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`text-left px-3.5 py-2 rounded-card border transition-colors min-w-[220px] ${
              on ? 'border-acc bg-acc-soft' : 'border-line-hairline bg-surf hover:border-line-strong'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-[7px] h-[7px] rounded-full shrink-0 ${on ? 'bg-acc' : 'bg-[#D0D5DD]'}`}
                aria-hidden="true"
              />
              <span className={`text-[12.5px] font-semibold ${on ? 'text-acc-hover' : 'text-ink'}`}>{o.label}</span>
            </div>
            <div className={`text-[11px] mt-0.5 pl-[15px] ${on ? 'text-acc-hover opacity-80' : 'text-ink-faint'}`}>
              {o.hint}
            </div>
          </button>
        );
      })}
    </div>
  );
}
