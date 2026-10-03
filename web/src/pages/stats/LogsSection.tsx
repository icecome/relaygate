import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard';
import { useAuth } from '../../stores/useAuth';
import {
  getTraffic,
  getSseDebugStatus,
  getSseDebug,
  type TrafficResponse,
  type TrafficRow,
  type SseDebugRow,
} from '../../api/admin';
import { fmtTokens, humanError } from '../../lib/format';
import { useSummary } from '../../stores/useSummary';

type LogMode = 'feed' | 'table';

/** 同一秒内同账号可能有多条记录，seq 由 traffic.jsonl 逐行写入，优先用它做行 key */
function rowKey(r: TrafficRow, i: number) {
  return r.seq != null ? `s${r.seq}` : `${r.ts}_${r.account}_${i}`;
}

/**
 * 请求日志。原先与统计面板同页，靠页内二级 tab 切换；
 * 新结构下统计已拆为独立子栏，此处只保留日志部分。
 */
export default function LogsSection() {
  const { key } = useAuth();
  const { data: summary } = useSummary();
  const [mode, setMode] = useState<LogMode>(() => (localStorage.getItem('tr_log_mode') as LogMode) || 'feed');
  const [rows, setRows] = useState<TrafficRow[]>([]);
  const [stats, setStats] = useState<TrafficResponse['summary'] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalScan, setTotalScan] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // SSE 调试
  const [sseEnabled, setSseEnabled] = useState(false);
  const [sseRows, setSseRows] = useState<SseDebugRow[]>([]);
  const [sseExpanded, setSseExpanded] = useState<string | null>(null);

  const pageSize = 50;

  const load = useCallback(
    (p = page) => {
      if (!key) return;
      getTraffic({ page: p, pageSize, status: status || undefined }, key)
        .then((d) => {
          setRows(d.data || []);
          setStats(d.summary || null);
          setTotal(d.total || 0);
          setTotalScan(d.totalScan || 0);
          setPage(d.page || 1);
          setTotalPages(d.totalPages || 1);
          setErr(null);
        })
        .catch((e: Error) => setErr(e.message));
    },
    [key, pageSize, status, page],
  );

  const loadSseStatus = useCallback(() => {
    if (!key) return;
    getSseDebugStatus(key).then((d) => setSseEnabled(d.enabled)).catch(() => {});
  }, [key]);

  const loadSse = useCallback(
    (requestId?: string) => {
      if (!key) return;
      getSseDebug({ days: 1, requestId, limit: 100 }, key)
        .then((d) => setSseRows(d.data || []))
        .catch(() => {});
    },
    [key],
  );

  useEffect(() => {
    if (key) load(1);
  }, [key, status]);

  useEffect(() => {
    if (key) loadSseStatus();
  }, [key, loadSseStatus]);

  function acctLabel(id?: string) {
    if (!id) return '未知账号';
    const hit = summary?.accounts.find((a) => a.id === id);
    return hit?.label || id;
  }

  function feedItem(r: TrafficRow, i: number) {
    const t = (r.ts || '').replace('T', ' ').slice(11, 19);
    const label = acctLabel(r.account);
    const model = r.model || '未知模型';
    const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)} 秒` : '—';
    const metered = r.promptTokens != null || r.completionTokens != null || r.totalTokens != null;
    const tok = metered ? `，消耗 ${fmtTokens(r.promptTokens)} + ${fmtTokens(r.completionTokens)} tokens` : '，上游未回传 usage';
    const tools = r.toolCalls && r.toolCalls > 0 ? `，执行 ${r.toolCalls} 次工具调用` : '';
    const ep = (r.endpoint || '').replace('/v1/', '');
    if (r.error || (r.status && r.status >= 400)) {
      return (
        <div
          key={rowKey(r, i)}
          className="px-4 py-3 border-b border-line last:border-b-0 text-[13px] leading-6 bg-danger-soft/60 flex items-start gap-2.5"
        >
          <span className="mt-1.5 w-2 h-2 rounded-full bg-danger shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="text-ink-faint tabular-nums mr-2">{t}</span>
            <span>
              账号「<b className="text-ink">{label}</b>」调用 {model} <b className="text-danger">失败</b>：{humanError(r.error)}
            </span>
            <span className="ml-1.5 text-ink-faint text-xs">
              {ep} · {r.status || 'ERR'}
            </span>
          </span>
        </div>
      );
    }
    return (
      <div
        key={rowKey(r, i)}
        className="px-4 py-3 border-b border-line last:border-b-0 text-[13px] leading-6 flex items-start gap-2.5"
      >
        <span className="mt-1.5 w-2 h-2 rounded-full bg-acc shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="text-ink-faint tabular-nums mr-2">{t}</span>
          <span>
            账号「<b className="text-ink">{label}</b>」通过 <b className="text-ink">{model}</b> 完成一次调用：耗时 {dur}
            {tools}
            {tok}。
          </span>
          <span className="ml-1.5 text-ink-faint text-xs">{ep}</span>
        </span>
      </div>
    );
  }

  const modelTop = Object.entries(stats?.byModel ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard label="扫描条数" value={totalScan} hint="近 1 天" />
        <StatCard label="错误" value={stats?.byStatus?.error || 0} hint="含 status≥400" accent="warn" />
        <StatCard label="token 消耗" value={fmtTokens(stats?.tokens)} hint="近 1 天已计量合计" />
        <StatCard
          label="模型分布"
          value={<span className="text-sm font-medium leading-6">{modelTop || '—'}</span>}
          hint="按调用次数"
        />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <label className="sr-only" htmlFor="log-status">
          日志状态筛选
        </label>
        <select id="log-status" className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">状态：全部</option>
          <option value="200">状态：200</option>
          <option value="error">状态：错误</option>
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const next = mode === 'feed' ? 'table' : 'feed';
            setMode(next);
            localStorage.setItem('tr_log_mode', next);
          }}
        >
          {mode === 'feed' ? '切换为表格' : '切换为自然语言'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => load()}>
          刷新日志
        </button>
        {sseEnabled && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              loadSse();
              setSseExpanded(sseExpanded ? null : '__all__');
            }}
          >
            查看 SSE 调试
          </button>
        )}
        <span className="ml-auto text-xs text-ink-faint">
          {total > 0 ? `共 ${total} 条 · 扫描 ${totalScan}` : '来自 traffic.jsonl'}
        </span>
      </div>

      {sseEnabled && sseExpanded === '__all__' && (
        <div className="panel">
          <div className="px-4 py-2.5 bg-surf-soft text-[13px] border-b border-line font-medium">
            SSE 调试事件（近 1 天，共 {sseRows.length} 条）
          </div>
          {sseRows.length === 0 ? (
            <div className="text-center py-6 text-ink-soft text-[13px]">暂无 SSE 调试记录（需 TRAE_DEBUG_SSE=true）</div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              {sseRows.slice(0, 50).map((r, i) => (
                <div key={i} className="px-4 py-2 border-b border-line last:border-b-0 text-[12px] font-mono">
                  <span className="text-ink-faint tabular-nums mr-2">{(r.ts || '').slice(11, 19)}</span>
                  <span className="text-ink-faint mr-2">#{r.seq}</span>
                  <span className="text-ink mr-2">{r.model || '—'}</span>
                  <span className="text-ink-soft">
                    {r.event?.type || 'chunk'}: {(r.event?.chunk || '').slice(0, 120)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="panel">
        {err ? (
          <div className="text-center py-8 text-ink-soft">{err}</div>
        ) : mode === 'feed' ? (
          <div>
            {!rows.length ? (
              <div className="text-center py-8 text-ink-soft">
                <div className="text-sm font-medium text-ink mb-1">暂无调用记录</div>
                <div className="text-[13px]">客户端调用转发接口后，这里会用一句话描述每次调用</div>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 bg-surf-soft text-[13px]">
                  本页 {rows.length} 条记录中{' '}
                  <b className="text-ink">{rows.filter((r) => !r.error && !(r.status && r.status >= 400)).length}</b> 次成功，累计消耗{' '}
                  <b className="text-ink">{fmtTokens(rows.reduce((s, r) => s + (Number(r.totalTokens) || 0), 0))}</b> tokens。
                  {(() => {
                    const cost = rows.reduce((s, r) => s + (Number(r.estimatedCost) || 0), 0);
                    return cost > 0 ? (
                      <>
                        {' '}
                        · 估算消耗 <b className="text-ink">{cost.toFixed(2)}</b> 积分
                      </>
                    ) : null;
                  })()}
                </div>
                {rows.map((r, i) => feedItem(r, i))}
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">时间</th>
                  <th className="th">端点</th>
                  <th className="th">模型</th>
                  <th className="th">账号</th>
                  <th className="th cell-num">耗时</th>
                  <th className="th cell-num">tokens</th>
                  <th className="th cell-num">估算积分</th>
                  <th className="th">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const stOk = !r.error && !(r.status && r.status >= 400);
                  const metered = r.promptTokens != null || r.completionTokens != null || r.totalTokens != null;
                  return (
                    <tr key={rowKey(r, i)} className="row-hover">
                      <td className="td text-ink-faint">{(r.ts || '').replace('T', ' ').slice(0, 19)}</td>
                      <td className="td text-ink-faint">{r.endpoint || '—'}</td>
                      <td className="td">{r.model || '—'}</td>
                      <td className="td text-ink-faint" title={r.account || ''}>
                        {String(r.account || '—').slice(0, 14)}
                      </td>
                      <td className="td cell-num text-ink-faint">{r.durationMs != null ? `${r.durationMs}ms` : '—'}</td>
                      <td className="td cell-num text-ink-faint" title={metered ? '' : '上游未回传 usage'}>
                        {metered ? fmtTokens(r.totalTokens) : <span className="text-warn">未计量</span>}
                      </td>
                      <td className="td cell-num text-ink-faint">{r.estimatedCost != null ? r.estimatedCost.toFixed(2) : '—'}</td>
                      <td className="td">
                        {stOk ? (
                          <span className="pill-ok">{r.status || 200}</span>
                        ) : (
                          <span className="pill-muted" title={r.error || ''}>
                            失败
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => load(page - 1)}>
            上一页
          </button>
          <span className="text-xs text-ink-faint tabular-nums min-w-[140px] text-center">
            第 {page} / {totalPages} 页 · 共 {total} 条
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => load(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </div>
  );
}