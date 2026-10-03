import { useAuth } from '../stores/useAuth';

const CONN_STYLE: Record<string, string> = {
  ok: 'bg-acc-soft text-[#065F46] border-transparent',
  err: 'bg-danger-soft text-danger border-transparent cursor-help',
  connecting: 'bg-surf-soft text-ink-soft border-line',
  unset: 'bg-surf-soft text-ink-soft border-line',
};

export default function Header() {
  const { key } = useAuth();
  const connState = key ? 'ok' : 'unset';
  const label = key ? '已连接' : '未配置';

  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-5 bg-surf border-b border-line">
      <span className="text-[13px] text-ink-soft">Trae · WorkBuddy 账号池网关</span>
      <span
        className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11px] font-medium border ${CONN_STYLE[connState]}`}
        title={key ? '数据接口正常' : '尚未保存访问密钥'}
      >
        <span className="w-[6px] h-[6px] rounded-full bg-current" aria-hidden="true" />
        {label}
      </span>
    </header>
  );
}