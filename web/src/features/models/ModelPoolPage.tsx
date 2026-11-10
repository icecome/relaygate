/**
 * 模型池状态页，展示三类模型（对照后端 routes/models.js 的 listModels）：
 *   虚拟模型 —— model-router 聚合，声明 contextWindow，带候选数与可用候选数；
 *   Trae CN —— 官方模型配置接口目录，提供倍率与能力标签；
 *   WorkBuddy —— 官方模型目录，提供倍率与最大输入 token。
 * 请求数 / 错误数来自 /v1/admin/models/stats（traffic 日志聚合），与池状态按模型 ID 关联。
 *
 * 状态有四种，来源互不相同，不要混读：
 *   usable / unavailable / unknown  来自探活结论（models/availability.js）；
 *   media                            来自目录能力位（无 chat 端点，不参与探活与转发）。
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
import { formatDuration, formatNumber, formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
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

/**
 * 来源筛选。
 *
 * 从 `'all' | 'virtual' | 'trae' | 'workbuddy'` 改成**由数据派生**的开放集合：
 * 后端的 `source` 取值有 `trae-cn / workbuddy-cn / raccoon / model-router` 四种
 * （`routes/models.js` 的 `/v1/models/status`），而写死三档时 Raccoon 的模型
 * 只能靠「全部来源」翻——平台数量每加一个，这里就要改一次，漏改的表现是
 * 「这个平台的模型筛不出来」而不是报错。
 *
 * 现在 `source` 只存后端原值（或 `'all'`），选项与计数从当前数据现算。
 */
type SourceFilter = string;

/** 目录来源枚举 → 面向用户的说法（'upstream' 直接显示会被读成英文单词）。 */
const SOURCE_LABEL: Record<string, string> = {
  upstream: '上游接口',
  remote: '上游接口',
  local: '本地缓存',
  fallback: '内置兜底表',
  cache: '本地缓存',
};

function directorySourceLabel(source: string | null | undefined): string {
  if (!source) return '—';
  return SOURCE_LABEL[source] ?? source;
}

/** 模型清单的「来源」列：后端下发的是平台 id（trae-cn / workbuddy-cn）。 */
const PLATFORM_SOURCE_LABEL: Record<string, string> = {
  'trae-cn': 'Trae 国内版',
  'trae-intl': 'Trae 国际版',
  'workbuddy-cn': 'WorkBuddy 国内版',
  'workbuddy-intl': 'WorkBuddy 国际版',
};

/**
 * 模型清单的「来源」列。
 *
 * 后端同时给 source（平台 id：trae-cn / workbuddy-cn / model-router）与
 * source_name（平台展示名：Trae CN / WorkBuddy CN / 虚拟模型）。
 * 平台 id 能给更精确的措辞（「Trae 国内版」），虚拟模型的 id 不可读，
 * 直接用它自带的展示名。两级回退，避免把 model-router 这种机器标识露到界面上。
 */
function platformSourceLabel(source: string | null | undefined, sourceName?: string | null): string {
  if (source && PLATFORM_SOURCE_LABEL[source]) return PLATFORM_SOURCE_LABEL[source];
  if (sourceName) return sourceName;
  return source || '—';
}

/** 账号池调度策略：后端值是机器标识（least_balance / round_robin），面板给中文名。 */
const POOL_STRATEGY_LABEL: Record<string, string> = {
  least_balance: '余额与到期优先',
  round_robin: '轮询',
};

/** 上游调用方式（function 字段）：展示中文名，等宽字体保留原值便于对照日志。 */
const UPSTREAM_FUNCTION_LABEL: Record<string, string> = {
  chat_v3: '对话（chat_v3）',
  inline_chat: '内联对话（inline_chat）',
  solo_work_lite: 'TraeWork（solo_work_lite）',
};
type StatusFilter = 'all' | 'usable' | 'unavailable' | 'unknown' | 'media';

/**
 * 状态映射，取值与后端 routes/models.js 一致：
 *   usable       探活成功过；
 *   unavailable  探活失败（带 TTL，过期自动回落 unknown）；
 *   unknown      尚无探活记录；
 *   media        目录里的图片/视频生成模型，没有 chat 端点，不参与探活与转发。
 *
 * 前三种是「探活结论」，第四种是「目录能力位」——两者不同源，不要互相当成校验依据。
 * 后端回退到目录时 status 可能缺失，故做穷举映射并给出默认值，
 * 保证未知取值只降级显示、不中断整页渲染。
 */
const STATUS_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; dot: string }> = {
  usable: { label: '可用', tone: 'ok', dot: 'dot-ok' },
  unavailable: { label: '不可用', tone: 'danger', dot: 'dot-error' },
  unknown: { label: '未探测', tone: 'warn', dot: 'dot-cool' },
  media: { label: '媒体模型', tone: 'neutral', dot: 'dot-off' },
};

const UNKNOWN_STATUS = { label: '未知', tone: 'warn' as const, dot: 'dot-cool' };

/** 未知取值的最后手段映射，避免映射缺失导致渲染中断。 */
function statusMeta(status: ModelInfo['status']) {
  return STATUS_META[status ?? ''] ?? UNKNOWN_STATUS;
}

const CAPABILITY_LABEL: Record<string, string> = {
  reasoning_model: '推理',
  chat_model: '对话',
  virtual_router: '虚拟路由',
  media_model: '媒体生成',
};

/** 媒体模型类型 → 展示词。 */
const MEDIA_KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  other: '媒体',
};

/**
 * 不可用原因的分类前缀。
 *
 * 后端把「套餐额度不足」这类账号级结论写成 `[套餐层] …`，与「模型下线」区分开：
 * 前者换个号或升级套餐就能用，后者是平台侧事实。面板把前缀渲染成标签，不裸露方括号。
 */
const REASON_PREFIX_RE = /^\[([^\]]+)\]\s*/;

function splitReason(reason: string | null | undefined): { tag: string | null; text: string } {
  const raw = String(reason || '');
  const m = REASON_PREFIX_RE.exec(raw);
  if (!m) return { tag: null, text: raw };
  return { tag: m[1], text: raw.slice(m[0].length) };
}

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

  /** 用量按模型 ID 索引；traffic 里的 model 名与池状态 ID 同源。 */
  const usageByModel = useMemo(() => {
    const map = new Map<string, ModelUsageStat>();
    for (const u of usage.data?.data ?? []) map.set(u.model, u);
    return map;
  }, [usage.data]);

  const rows = useMemo(() => {
    const all = status_.data?.data ?? [];
    return all.filter((m) => {
      // 'model-router' 是虚拟模型行的 source 原值；其余按平台 id 精确匹配。
      // 不再为每个平台写一条 if——新增平台不需要改这里。
      if (source !== 'all' && (m.source ?? '') !== source) return false;
      if (status !== 'all' && m.status !== status) return false;
      return true;
    });
  }, [status_.data, source, status]);

  /**
   * 来源选项：从数据里出现的 source 集合现算，带计数。
   * 顺序固定为 虚拟模型 → Trae → WorkBuddy → 其余，便于肌肉记忆。
   */
  const sourceOptions = useMemo(() => {
    const all = status_.data?.data ?? [];
    const counts = new Map<string, number>();
    for (const m of all) {
      const s = m.source ?? '';
      if (!s) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const order: Record<string, number> = { 'model-router': 0, 'trae-cn': 1, 'workbuddy-cn': 2 };
    const keys = [...counts.keys()].sort(
      (a, b) => (order[a] ?? 9) - (order[b] ?? 9) || a.localeCompare(b),
    );
    return [
      { value: 'all', label: `全部来源（${formatNumber(all.length)}）` },
      ...keys.map((k) => ({
        value: k,
        label: `${platformSourceLabel(k, null)}（${formatNumber(counts.get(k) ?? 0)}）`,
      })),
    ];
  }, [status_.data]);

  /** 按状态计数（一次遍历，表格与指标共用同一口径）。 */
  const counts = useMemo(() => {
    const all = status_.data?.data ?? [];
    const c = { total: all.length, usable: 0, unavailable: 0, unknown: 0, media: 0, virtual: 0 };
    for (const m of all) {
      if (m.virtual) c.virtual += 1;
      const s = m.status ?? 'unknown';
      if (s === 'usable') c.usable += 1;
      else if (s === 'unavailable') c.unavailable += 1;
      else if (s === 'media') c.media += 1;
      else c.unknown += 1;
    }
    return c;
  }, [status_.data]);

  const metrics = [
    {
      key: '模型总数',
      value: formatNumber(counts.total),
      // 媒体模型单独计数：它们计入目录总数，但不参与转发与探活，
      // 放在这里是为了让「总数 = 可用 + 不可用 + 未探测 + 媒体」能对上。
      delta: [
        `目录来源：${directorySourceLabel(status_.data?.source)}`,
        counts.media > 0 ? `媒体模型 ${formatNumber(counts.media)}` : null,
      ].filter(Boolean).join(' · '),
    },
    {
      key: '可用',
      value: formatNumber(counts.usable),
      delta: `不可用 ${formatNumber(counts.unavailable)} · 未探测 ${formatNumber(counts.unknown)}`,
    },
    {
      key: '虚拟模型',
      value: formatNumber(counts.virtual),
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
        toast(`拉取未成功：${r.error ?? '网关未返回失败原因；若持续出现，请到「运维 → 定时任务」查看任务日志'}`, 'err');
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
      message:
        '将清除所有对话模型的「可用 / 不可用」标记，下次探测后重新判定。媒体模型不写入可用性表，不受影响。',
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

  /**
   * 探测指定模型。
   *
   * 行内按钮此前先 setProbeModelName(m.id) 再同步调 probe()，而 probe() 读的是
   * 本次渲染的闭包值 —— 探测的其实是上一次填进输入框的模型或空串。
   * 现在把目标作为实参传入，不依赖 state 是否已更新。
   */
  async function probe(target?: string) {
    const model = (target ?? probeModelName).trim();
    if (!model) {
      toast('未填写模型名，无法开始探测', 'warn');
      return;
    }
    setBusy('probe');
    setProbeResult(null);
    try {
      const r = await probeModel(model, key);
      setProbeResult({ model, ok: r.ok, message: r.message ?? (r.ok ? '探测通过' : '探测失败') });
      // 探测会改变后端的可用性判定，需重新拉取池状态
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
      description="虚拟模型、Trae CN 与 WorkBuddy 的目录、可用性与媒体模型"
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
            {/* 来源筛选：选项由当前数据派生（含 Raccoon 等），不再写死三档 */}
            <select
              className="h-8 rounded-md border px-2 text-[13px] max-w-[220px]"
              style={{
                borderColor: 'var(--rg-border-stronger)',
                background: 'var(--rg-bg-base)',
                color: 'var(--rg-text-primary)',
              }}
              aria-label="来源筛选"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {sourceOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Segmented
              ariaLabel="状态筛选"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'usable', label: '可用' },
                { value: 'unavailable', label: '不可用' },
                { value: 'unknown', label: '未探测' },
                { value: 'media', label: '媒体模型' },
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
            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
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
                {
                  k: '模型池策略',
                  v: (
                    <span>
                      {POOL_STRATEGY_LABEL[status_.data?.strategy ?? ''] || status_.data?.strategy || '—'}
                    </span>
                  ),
                },
                {
                  k: '上游调用方式',
                  v: (
                    <span>
                      {UPSTREAM_FUNCTION_LABEL[status_.data?.upstreamFunction ?? '']
                        || status_.data?.upstreamFunction
                        || '—'}
                    </span>
                  ),
                },
                {
                  k: '调用路径',
                  v: (
                    <span className="font-mono text-aux break-all">
                      {status_.data?.upstreamChatPath || '—'}
                    </span>
                  ),
                },
                {
                  k: '目录来源',
                  v: <span>{directorySourceLabel(status_.data?.source)}</span>,
                },
                {
                  k: '目录接口地址',
                  v: (
                    <span className="font-mono text-aux break-all">
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
          description="来源、可用性、倍率与所选区间用量；媒体模型不参与转发"
          flush
        >
          {status_.loading && !status_.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <EmptyState
              label="没有符合当前筛选条件的模型"
              hint="当前来源与状态筛选没有命中任何模型；可放宽筛选，或点右上角「拉取上游模型」重新同步目录。"
              action={{
                label: '清空筛选',
                onClick: () => {
                  setSource('all');
                  setStatus('all');
                },
              }}
            />
          ) : (
            <div className="scroll-y overflow-x-auto" style={{ maxHeight: 560 }}>
              <table className="data-table">
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
                    const isMedia = m.status === 'media' || m.chat === false;
                    const reason = splitReason(m.reason);
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
                          <div className="font-mono text-aux">{m.display_name || m.id}</div>
                          <div
                            className="font-mono text-aux"
                            style={{ color: 'var(--rg-text-tertiary)' }}
                          >
                            {m.id}
                            {m.virtual && m.candidates != null && (
                              <span style={{ color: 'var(--rg-brand-600)' }}>
                                {` · 可用候选 ${m.usableCandidates ?? '—'} / ${m.candidates}`}
                              </span>
                            )}
                          </div>
                          {reason.text && (
                            <div
                              className="text-aux"
                              style={{
                                color: isMedia
                                  ? 'var(--rg-text-tertiary)'
                                  : 'var(--rg-state-error)',
                              }}
                            >
                              {reason.tag && (
                                <Chip tone={reason.tag === '套餐层' ? 'warn' : 'neutral'}>
                                  {reason.tag}
                                </Chip>
                              )}{' '}
                              {reason.text}
                            </div>
                          )}
                        </td>
                        <td className="td">{platformSourceLabel(m.source, m.source_name)}</td>
                        <td className="td">
                          <Chip tone={meta.tone} dot={meta.dot}>
                            {meta.label}
                          </Chip>
                        </td>
                        <td className="td cell-num">
                          {m.rateText ?? (m.rate != null ? `×${m.rate}` : '—')}
                        </td>
                        <td className="td">
                          {isMedia ? (
                            <Chip tone="neutral">
                              {MEDIA_KIND_LABEL[m.mediaKind ?? 'other'] ?? '媒体生成'}
                            </Chip>
                          ) : m.multimodal ? (
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
                          {u?.avgDurationMs != null ? formatDuration(u.avgDurationMs) : '—'}
                        </td>
                        <td className="td cell-act">
                          {isMedia ? (
                            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                              无 chat 端点
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy === 'probe'}
                              onClick={() => {
                                setProbeModelName(m.id);
                                void probe(m.id);
                              }}
                            >
                              探测
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="模型探测" description="向上游发起一次真实请求，用于验证连通性">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="w-[280px]">
              <Field
                label="模型名"
                value={probeModelName}
                onChange={(e) => setProbeModelName(e.target.value)}
                placeholder="例如 glm-5.3 或 wb/glm-5.3"
              />
            </div>
            <Button variant="primary" onClick={() => void probe()} disabled={busy === 'probe'}>
              {busy === 'probe' ? '探测中…' : '探测'}
            </Button>
          </div>

          {probeResult && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-aux">{probeResult.model}</span>
                <Chip tone={probeResult.ok ? 'ok' : 'danger'} dot={probeResult.ok ? 'dot-ok' : 'dot-error'}>
                  {probeResult.ok ? '通过' : '失败'}
                </Chip>
              </div>
              <p className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                {probeResult.message}
              </p>
              <div className="mt-3">
                <Note>探测会真实消耗上游配额，并改变该模型的可用性判定。</Note>
              </div>
            </div>
          )}
        </Panel>

        <Note>
          状态列有三种来源：可用 / 不可用 / 未探测来自真实调用结论（不可用带有效期，到期自动重探）；
          媒体模型来自目录能力位——图片与视频生成模型没有 chat 端点，不参与转发与探测。
          倍率（×）为积分消耗倍率，两个平台的目录接口均未提供峰谷价格。
        </Note>
      </Stack>
    </PageShell>
  );
}