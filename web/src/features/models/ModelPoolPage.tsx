/**
 * 模型池状态页。
 *
 * 展示三类模型（对照后端 routes/models.js 的 listModels）：
 *   虚拟模型  —— model-router 聚合，声明 contextWindow，带候选数与可用候选数；
 *   Trae CN   —— 官方模型配置接口目录，提供倍率与能力标签；
 *   WorkBuddy —— 官方模型目录，提供倍率与最大输入 token。
 *
 * 请求数 / 错误数来自 /v1/admin/models/stats（traffic 日志聚合），
 * 与池状态按模型 id 关联；上游模型目录不提供上下文窗口，
 * 因此该列对非虚拟模型显示「—」而不是编造数值。
 */
import { useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  clearModelsStatus,
  getCatalogStatus,
  getModelUsageStats,
  getModelsStatus,
  probeModel,
  refreshModels,
  type ModelInfo,
  type ModelUsageStat,
} from '../../shared/api/admin';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatNumber, formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  Field,
  KeyValue,
  LoadingBlock,
  MetricGrid,
  Note,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';

type SourceFilter = 'all' | 'virtual' | 'trae' | 'workbuddy';
type StatusFilter = 'all' | 'usable' | 'unavailable';

/**
 * 状态映射。
 *
 * 取值与 models/availability.js 的三态一致：
 *   usable     探测成功过；
 *   unavailable  探测失败（带 TTL，过期自动回落unknown）；
 *   unknown    尚无探测记录。
 * 目录兜底路径下 status 可能缺失，故做穷举映射 + 默认值，
 * 保证未知取值只降级显示、不中断整页渲染。
 */
const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger'; dot: string }> = {
  usable: { label: '可用', tone: 'ok', dot: 'dot-ok' },
  unavailable: { label: '不可用', tone: 'danger', dot: 'dot-error' },
  unknown: { label: '未探测', tone: 'warn', dot: 'dot-cool' },
};

const UNKNOWN_STATUS = { label: '未知', tone: 'warn' as const, dot: 'dot-cool' };

/** 未知取值兜底，避免映射缺失导致渲染中断。 */
function statusMeta(status: ModelInfo['status']) {
  return STATUS_META[status ?? ''] ?? UNKNOWN_STATUS;
}

const CAPABILITY_LABEL: Record<string, string> = {
  reasoning_model: '推理',
  chat_model: '对话',
  virtual_router: '虚拟路由',
};

interface ProbeResult {
  model: string;
  ok: boolean;
  message: string;
}

export default function ModelPoolPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();

  const [source, setSource] = useState<SourceFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [statsDays, setStatsDays] = useState<'1' | '7'>('7');
  const [probeModelName, setProbeModelName] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const status_ = useAsyncData((signal) => getModelsStatus(key, signal), [key], { enabled: !!key });
  const catalog = useAsyncData((signal) => getCatalogStatus(key, signal), [key], { enabled: !!key });
  const usage = useAsyncData(
    (signal) => getModelUsageStats(Number(statsDays), key, signal),
    [statsDays, key],
    { enabled: !!key },
  );

  /** 用量按模型 id 索引；traffic 里的 model 名与池状态 id 同源。 */
  const usageByModel = useMemo(() => {
    const map = new Map<string, ModelUsageStat>();
    for (const u of usage.data?.data ?? []) map.set(u.model, u);
    return map;
  }, [usage.data]);

  const rows = useMemo(() => {
    const all = status_.data?.data ?? [];
    return all.filter((m) => {
      if (source === 'virtual' && !m.virtual) return false;
      if (source === 'trae' && m.source !== 'trae-cn') return false;
      if (source === 'workbuddy' && m.source !== 'workbuddy-cn') return false;
      if (status === 'usable' && m.status !== 'usable') return false;
      if (status === 'unavailable' && m.status !== 'unavailable') return false;
      return true;
    });
  }, [status_.data, source, status]);

  const metrics = [
    {
      key: '模型总数',
      value: formatNumber(status_.data?.data?.length ?? 0),
      delta: `目录来源 ${status_.data?.source ?? '—'}`,
    },
    {
      key: '可用',
      value: formatNumber((status_.data?.data ?? []).filter((m) => m.status === 'usable').length),
    },
    {
      key: '虚拟模型',
      value: formatNumber((status_.data?.data ?? []).filter((m) => m.virtual).length),
    },
    {
      key: `${statsDays === '1' ? '今日' : '近 7 日'}请求`,
      value: formatNumber((usage.data?.data ?? []).reduce((s, u) => s + u.requests, 0)),
      delta: `错误 ${formatNumber((usage.data?.data ?? []).reduce((s, u) => s + u.errors, 0))}`,
    },
  ];

  async function refresh() {
    setBusy('refresh');
    try {
      const r = await refreshModels(key);
      if (r.ok) {
        toast(`已拉取上游模型：${r.count ?? 0} 个`, 'ok');
        status_.reload();
        catalog.reload();
      } else {
        // 后端拉取失败会带 error 文本，属业务层失败
        toast(`拉取未成功：${r.error ?? '后端未给出原因'}`, 'err');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '拉取失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    const ok = await prompt({
      title: '清理全部可用性标记？',
      message: '将清除所有模型的可用 / 不可用标记，下次探测后重新判定。',
      okText: '清理',
      danger: true,
    });
    if (ok !== true) return;
    setBusy('clear');
    try {
      await clearModelsStatus(undefined, key);
      toast('已清理可用性标记', 'ok');
      status_.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '清理失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function probe() {
    const model = probeModelName.trim();
    if (!model) {
      toast('请输入模型名', 'warn');
      return;
    }
    setBusy('probe');
    setProbeResult(null);
    try {
      const r = await probeModel(model, key);
      setProbeResult({ model, ok: r.ok, message: r.message ?? (r.ok ? '探测通过' : '探测失败') });
      // 探测会改变后端的可用性判定，需刷新池状态
      status_.reload();
    } catch (e) {
      setProbeResult({
        model,
        ok: false,
        message: e instanceof ApiError ? e.message : '探测请求失败',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell
      title="模型池状态"
      description="虚拟模型与两个上游平台的模型目录"
      actions={
        <>
          <Button onClick={clearAll} disabled={busy === 'clear'}>
            清理可用性标记
          </Button>
          <Button variant="primary" onClick={refresh} disabled={busy === 'refresh'}>
            {busy === 'refresh' ? '拉取中…' : '拉取上游模型'}
          </Button>
        </>
      }
      toolbar={
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <Segmented
              ariaLabel="来源筛选"
              value={source}
              onChange={setSource}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'virtual', label: '虚拟模型' },
                { value: 'trae', label: 'Trae CN' },
                { value: 'workbuddy', label: 'WorkBuddy' },
              ]}
            />
            <Segmented
              ariaLabel="状态筛选"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'usable', label: '可用' },
                { value: 'unavailable', label: '不可用' },
              ]}
            />
          </div>
          <div className="flex items-center gap-3">
            <Segmented
              ariaLabel="用量统计区间"
              value={statsDays}
              onChange={setStatsDays}
              options={[
                { value: '1', label: '今日' },
                { value: '7', label: '近 7 日' },
              ]}
            />
            <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              共 {rows.length} 个模型
            </span>
          </div>
        </>
      }
    >
      <Stack>
        {status_.error && <ErrorState message={status_.error} onRetry={status_.reload} />}

        <MetricGrid items={metrics} />

        <Panel title="池状态" description="目录来源与同步信息">
          {status_.loading && !status_.data ? (
            <LoadingBlock />
          ) : (
            <KeyValue
              rows={[
                { k: '池化策略', v: <span className="font-mono">{status_.data?.strategy || '—'}</span> },
                {
                  k: '上游函数',
                  v: <span className="font-mono">{status_.data?.upstreamFunction || '—'}</span>,
                },
                {
                  k: '上游路径',
                  v: (
                    <span className="font-mono text-[12px] break-all">
                      {status_.data?.upstreamChatPath || '—'}
                    </span>
                  ),
                },
                { k: '目录来源', v: <span className="font-mono">{status_.data?.source || '—'}</span> },
                {
                  k: '目录接口',
                  v: (
                    <span className="font-mono text-[12px] break-all">
                      {status_.data?.endpoint || '—'}
                    </span>
                  ),
                },
                { k: '同步时间', v: <span className="font-mono">{formatTime(status_.data?.syncedAt)}</span> },
                {
                  k: '模型目录',
                  v: catalog.data ? (
                    <span className="font-mono">
                      {formatNumber(catalog.data.count ?? 0)} 个 · {formatTime(catalog.data.syncedAt)}
                    </span>
                  ) : (
                    '—'
                  ),
                },
                { k: '主机说明', v: status_.data?.hostNote || '—' },
              ]}
            />
          )}
        </Panel>

        <Panel
          title="模型清单"
          description="可用性、倍率与区间用量"
          flush
        >
          {status_.loading && !status_.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              没有符合条件的模型
            </div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 560 }}>
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">模型</th>
                    <th className="th">来源</th>
                    <th className="th">状态</th>
                    <th className="th cell-num">倍率</th>
                    <th className="th">能力</th>
                    <th className="th cell-num">上下文窗口</th>
                    <th className="th cell-num">请求</th>
                    <th className="th cell-num">错误</th>
                    <th className="th cell-num">平均延迟</th>
                    <th className="th cell-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const meta = statusMeta(m.status);
                    const u = usageByModel.get(m.id);
                    return (
                      <tr
                        key={m.id}
                        className="row-hover"
                        style={
                          m.status === 'unavailable'
                            ? { color: 'var(--rg-text-disabled)' }
                            : undefined
                        }
                      >
                        <td className="td">
                          <div className="font-mono text-[12px]">{m.display_name || m.id}</div>
                          <div
                            className="font-mono text-[11px]"
                            style={{ color: 'var(--rg-text-tertiary)' }}
                          >
                            {m.id}
                            {m.virtual && m.candidates != null && (
                              <span style={{ color: 'var(--rg-brand-600)' }}>
                                {` · 候选 ${m.usableCandidates ?? 0}/${m.candidates}`}
                              </span>
                            )}
                          </div>
                          {m.reason && (
                            <div className="text-[11px]" style={{ color: 'var(--rg-state-error)' }}>
                              {m.reason}
                            </div>
                          )}
                        </td>
                        <td className="td">{m.source_name || m.source || '—'}</td>
                        <td className="td">
                          <Chip tone={meta.tone} dot={meta.dot}>
                            {meta.label}
                          </Chip>
                        </td>
                        <td className="td cell-num">
                          {m.rateText ?? (m.rate != null ? `x${m.rate}` : '—')}
                        </td>
                        <td className="td">
                          {m.multimodal ? (
                            <Chip tone="brand">多模态</Chip>
                          ) : (
                            CAPABILITY_LABEL[m.capability ?? ''] || '—'
                          )}
                        </td>
                        <td className="td cell-num">
                          {m.contextWindow != null
                            ? formatNumber(m.contextWindow)
                            : m.maxInputTokens != null
                              ? formatNumber(m.maxInputTokens)
                              : '—'}
                        </td>
                        <td className="td cell-num">{u ? formatNumber(u.requests) : '—'}</td>
                        <td className="td cell-num">
                          {u ? (
                            <span style={u.errors > 0 ? { color: 'var(--rg-state-error)' } : undefined}>
                              {formatNumber(u.errors)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td cell-num">
                          {u?.avgDurationMs != null ? `${u.avgDurationMs}ms` : '—'}
                        </td>
                        <td className="td cell-act">
                          <Button
                            size="sm"
                            disabled={busy === 'probe'}
                            onClick={() => {
                              setProbeModelName(m.id);
                              void probe();
                            }}
                          >
                            探测
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="模型探测" description="向上游发起一次真实请求以验证连通性">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="w-[280px]">
              <Field
                label="模型名"
                value={probeModelName}
                onChange={(e) => setProbeModelName(e.target.value)}
                placeholder="例如 claude-sonnet-4"
                aria-label="待探测的模型名"
              />
            </div>
            <Button variant="primary" onClick={probe} disabled={busy === 'probe'}>
              {busy === 'probe' ? '探测中…' : '探测'}
            </Button>
          </div>

          {probeResult && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-[12px]">{probeResult.model}</span>
                <Chip tone={probeResult.ok ? 'ok' : 'danger'} dot={probeResult.ok ? 'dot-ok' : 'dot-error'}>
                  {probeResult.ok ? '通过' : '失败'}
                </Chip>
              </div>
              <p className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
                {probeResult.message}
              </p>
              <div className="mt-3">
                <Note>探测会真实消耗上游配额，并改变该模型的可用性判定。</Note>
              </div>
            </div>
          )}
        </Panel>

        <Note>
          上游模型目录不提供上下文窗口，仅虚拟模型声明该值；倍率（x）为真实积分消耗率，两平台接口均未提供峰谷价格。
        </Note>
      </Stack>
    </PageShell>
  );
}