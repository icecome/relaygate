/**
 * 路由与虚拟模型页：上游 provider、虚拟模型映射与候选健康度。
 * 对应 /v1/admin/model-router/* 真实接口。
 */
import { Fragment, useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  deleteVirtual,
  getRouterOverview,
  patchCandidate,
  reloadRouter,
  resyncAutoTiers,
  unfreezeVirtual,
  upsertVirtual,
  type HealthRow,
} from '../../shared/api/modelRouter';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatDuration, formatNumber, percent } from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  LoadingBlock,
  MetricGrid,
  Note,
  Panel,
  ProgressBar,
  Stepper,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';

/**
 * 候选不可用原因的中文说明。
 * 取值来自后端 explainCandidates().reasons，不做二次推断。
 */
const REASON_TEXT: Record<string, string> = {
  candidate_disabled: '候选已停用',
  provider_missing: 'Provider 不存在',
  provider_disabled: 'Provider 已停用',
  platform_denied: '密钥平台不匹配',
  rate_limited: '限流冷却中',
};

/** 倍率展示：0 显示为「免费」，避免被读成「无数据」。 */
function formatRate(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  if (rate === 0) return '免费';
  return `x${rate}`;
}

export default function ModelRouterPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  // 展开的虚拟模型 id 集合：聚合模型下分配了哪些上游模型，需逐个展开查看
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 轮转池大小（rotateTopN）：0 = 不轮转，固定取成本序首选。 */
  async function setRotateTopN(id: string, current: number, next: number) {
    if (next === current || next < 0) return;
    setBusy(id);
    try {
      await upsertVirtual(id, { rotateTopN: next }, key);
      toast(next === 0 ? '已关闭轮转，固定取成本首选' : `轮转池已调整为 ${next} 个`, 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  const overview = useAsyncData(
    (signal) => getRouterOverview(key, signal),
    [key],
    { enabled: !!key },
  );

  // 健康度按虚拟模型归组，便于在表格中直接展示
  const healthByVirtual = useMemo(() => {
    const map = new Map<string, HealthRow[]>();
    for (const h of overview.data?.health ?? []) {
      const arr = map.get(h.virtualId) ?? [];
      arr.push(h);
      map.set(h.virtualId, arr);
    }
    return map;
  }, [overview.data]);

  const metrics = useMemo(() => {
    const providers = overview.data?.providers ?? [];
    const virtuals = overview.data?.virtualModels ?? [];
    const enabledVirtuals = virtuals.filter((v) => v.enabled).length;
    const health = overview.data?.health ?? [];
    const cooling = health.filter((h) => h.cooling).length;
    return [
      { key: '上游Provider', value: formatNumber(providers.length) },
      { key: '虚拟模型', value: formatNumber(virtuals.length), delta: `启用 ${enabledVirtuals}` },
      { key: '候选总数', value: formatNumber(virtuals.reduce((s, v) => s + v.candidates.length, 0)) },
      {
        key: '冷却候选',
        value: formatNumber(cooling),
        delta: cooling > 0 ? '需关注可用性' : '全部正常',
      },
    ];
  }, [overview.data]);

  async function reloadRouterConfig() {
    setBusy('reload');
    try {
      await reloadRouter(key);
      toast('路由已重载', 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '重载失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function resync() {
    setBusy('resync');
    try {
      const r = await resyncAutoTiers(key);
      if (r.ok) {
        toast(`自动分层已同步：${r.tiers?.length ?? 0} 个层级`, 'ok');
      } else {
        // 业务层失败：展示后端原因，不当作网络错误
        toast(`同步未成功：${r.errors?.join('；') || '后端未给出原因'}`, 'err');
      }
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '同步失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function unfreeze(id: string) {
    setBusy(id);
    try {
      await unfreezeVirtual(id, key);
      toast('已解冻', 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '解冻失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function toggleVirtual(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await upsertVirtual(id, { enabled: !enabled }, key);
      toast(enabled ? '已停用' : '已启用', 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function removeVirtual(id: string) {
    const ok = await prompt({
      title: `删除虚拟模型 ${id}？`,
      message: '删除后客户端对该模型的调用将失败，此操作不可撤销。',
      okText: '删除',
      danger: true,
    });
    if (ok !== true) return;
    setBusy(id);
    try {
      await deleteVirtual(id, key);
      toast('已删除', 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '删除失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function patchCandidateFlags(
    virtualId: string,
    candidateId: string,
    patch: { enabled?: boolean; pinned?: boolean },
  ) {
    setBusy(`${virtualId}::${candidateId}`);
    try {
      await patchCandidate(virtualId, candidateId, patch, key);
      const label =
        patch.enabled === false ? '已禁用该候选' : patch.enabled === true ? '已启用该候选'
          : patch.pinned ? '已置顶，强制参与轮转' : '已取消置顶';
      toast(label, 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell
      title="路由与虚拟模型"
      description="上游 provider、虚拟模型映射与候选健康度"
      actions={
        <>
          <Button onClick={resync} disabled={busy === 'resync'}>
            {busy === 'resync' ? '同步中…' : '同步自动分层'}
          </Button>
          <Button variant="primary" onClick={reloadRouterConfig} disabled={busy === 'reload'}>
            {busy === 'reload' ? '重载中…' : '重载路由'}
          </Button>
        </>
      }
    >
      <Stack>
        {overview.error && <ErrorState message={overview.error} onRetry={overview.reload} />}

        <MetricGrid items={metrics} />

        <Panel title="上游 Provider" description="凭据来源与可用模型范围" flush>
          {overview.loading && !overview.data ? (
            <LoadingBlock />
          ) : (overview.data?.providers ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              尚未配置上游
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">名称</th>
                  <th className="th">类型</th>
                  <th className="th">状态</th>
                  <th className="th">密钥</th>
                  <th className="th cell-num">模型数</th>
                  <th className="th cell-num">超时</th>
                  <th className="th">Base URL</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.providers ?? []).map((p) => (
                  <tr key={p.id} className="row-hover">
                    <td className="td">
                      <div className="text-[13px]">{p.label}</div>
                      <div className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {p.id}
                      </div>
                    </td>
                    <td className="td">
                      {p.type === 'builtin' ? (
                        <Chip tone="brand">内置 · {p.builtin}</Chip>
                      ) : (
                        <Chip tone="neutral">第三方 OpenAI 兼容</Chip>
                      )}
                    </td>
                    <td className="td">
                      <Chip tone={p.enabled ? 'ok' : 'neutral'} dot={p.enabled ? 'dot-ok' : 'dot-off'}>
                        {p.enabled ? '启用' : '停用'}
                      </Chip>
                    </td>
                    <td className="td font-mono text-[12px]">
                      {p.type === 'builtin' ? (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>使用账号池凭据</span>
                      ) : p.hasApiKey ? (
                        p.apiKeyEnv ?? '已配置'
                      ) : (
                        <span style={{ color: 'var(--rg-state-warning)' }}>
                          未配置{p.apiKeyEnv ? ` ${p.apiKeyEnv}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="td cell-num">
                      {p.models?.length ? formatNumber(p.models.length) : '全部'}
                    </td>
                    <td className="td cell-num">{p.timeoutMs ? formatDuration(p.timeoutMs) : '—'}</td>
                    <td className="td font-mono text-[11px] break-all">{p.baseUrl || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="虚拟模型"
          description="对外暴露的模型名到候选序列的映射"
          flush
          footer="保存可能返回业务层失败（请求成功但结果未成功），此时会在对应表单内展示后端返回的原因。"
        >
          {overview.loading && !overview.data ? (
            <LoadingBlock />
          ) : (overview.data?.virtualModels ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无虚拟模型
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">虚拟模型</th>
                  <th className="th">策略</th>
                  <th className="th">来源</th>
                  <th className="th">声明窗口</th>
                  <th className="th cell-num">候选</th>
                  <th className="th">健康度</th>
                  <th className="th cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.virtualModels ?? []).map((v) => {
                  const hs = healthByVirtual.get(v.id) ?? [];
                  const cooling = hs.some((h) => h.cooling);
                  const okCount = hs.reduce((s, h) => s + h.ok, 0);
                  const failCount = hs.reduce((s, h) => s + h.fail, 0);
                  const rate = percent(okCount, okCount + failCount) / 100;
                  const isBusy = busy === v.id;
                  const open = expanded.has(v.id);
                  // 轮转池标记必须与后端 orderCandidates 一致：
                  // 池 = 置顶候选 + 「已启用候选」按成本序的前 rotateTopN 名。
                  // 已禁用的候选不占名额（后端会过滤后按可用列表切池）。
                  const enabledOnes = v.candidates.filter((c) => c.enabled !== false);
                  const costSorted = v.auto && v.sort
                    ? enabledOnes.slice().sort((a, b) => {
                        if (v.sort === 'window') {
                          const dw = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
                          if (dw) return dw;
                        } else {
                          const ar = typeof a.rate === 'number' ? a.rate : Infinity;
                          const br = typeof b.rate === 'number' ? b.rate : Infinity;
                          if (ar !== br) return ar - br;
                        }
                        return a.priority - b.priority || String(a.id).localeCompare(String(b.id));
                      })
                    : enabledOnes;
                  const poolSize = v.rotateTopN ?? 0;
                  const poolIds = new Set(
                    poolSize > 0
                      ? costSorted.slice(0, poolSize).map((c) => c.id)
                      : costSorted.slice(0, 1).map((c) => c.id),
                  );
                  for (const c of v.candidates) if (c.pinned && c.enabled !== false) poolIds.add(c.id);
                  const usableCount = v.candidates.filter((c) => c.usable !== false).length;
                  return (
                    <Fragment key={v.id}>
                      <tr className="row-hover">
                        <td className="td">
                          <div className="font-mono text-[12px] font-semibold">{v.id}</div>
                          {v.description && (
                            <div className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                              {v.description}
                            </div>
                          )}
                        </td>
                        <td className="td">
                          <Chip tone="brand">{v.strategy === 'weighted' ? '加权' : '优先级'}</Chip>
                          {v.auto && (
                            <div
                              className="mt-1 flex items-center gap-1"
                              title="轮转池大小：取倍率升序（sort=rate）前 N 个候选做加权轮转。0 表示关闭轮转，固定用最便宜的那个。"
                            >
                              <span className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                                轮转
                              </span>
                              <Stepper
                                value={v.rotateTopN ?? 0}
                                min={0}
                                max={v.candidates.length}
                                disabled={isBusy}
                                label={`${v.id} 轮转池大小`}
                                onChange={(n) => setRotateTopN(v.id, v.rotateTopN ?? 0, n)}
                              />
                            </div>
                          )}
                          {!v.auto && poolIds.size > 0 && (
                            <div className="text-[11px] mt-1" style={{ color: 'var(--rg-text-tertiary)' }}>
                              轮转 {poolIds.size} 个
                            </div>
                          )}
                        </td>
                        <td className="td">{v.auto ? '自动分层' : '手动'}</td>
                        <td className="td font-mono text-[12px]">
                          {v.contextWindow ? formatNumber(v.contextWindow) : '不设守门'}
                        </td>
                        <td className="td cell-num">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-expanded={open}
                            onClick={() => toggleExpanded(v.id)}
                          >
                            {open ? '收起' : '查看'}{' '}
                            <span className="font-mono">
                              {usableCount}/{v.candidates.length}
                            </span>
                          </button>
                        </td>
                        <td className="td">
                          {hs.length === 0 ? (
                            <span style={{ color: 'var(--rg-text-tertiary)' }}>无记录</span>
                          ) : (
                            <div className="min-w-[120px]">
                              <ProgressBar ratio={rate} tone={cooling ? 'warn' : 'brand'} />
                              <div className="text-[11px] mt-1 font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                                {cooling ? '冷却中' : `${okCount}/${okCount + failCount}`}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="td cell-act">
                          <div className="inline-flex items-center gap-1.5">
                            <Button size="sm" disabled={isBusy} onClick={() => toggleVirtual(v.id, v.enabled)}>
                              {v.enabled ? '停用' : '启用'}
                            </Button>
                            <Button size="sm" disabled={isBusy || !cooling} onClick={() => unfreeze(v.id)}>
                              解冻
                            </Button>
                            <Button size="sm" variant="danger" disabled={isBusy} onClick={() => removeVirtual(v.id)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td className="td" colSpan={8} style={{ background: 'var(--rg-bg-secondary)' }}>
                            <table className="w-full border-collapse text-[12px]">
                              <thead>
                                <tr>
                                  <th className="th">候选</th>
                                  <th className="th">上游</th>
                                  <th className="th cell-num">优先</th>
                                  <th className="th cell-num">权重</th>
                                  <th className="th cell-num">倍率</th>
                                  <th className="th cell-num">窗口</th>
                                  <th className="th">状态</th>
                                  <th className="th cell-act">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {v.candidates.map((c) => {
                                  const inPool = poolIds.has(c.id);
                                  const coolingNow =
                                    typeof c.cooldownRemainingMs === 'number' && c.cooldownRemainingMs > 0;
                                  // candidate_disabled 是候选自身的停用开关，已由「状态」列表达，
                                  // 这里只在存在其他阻断原因时才提示，避免同一个事实显示两遍。
                                  const reasons = (c.reasons ?? []).filter(
                                    (x) => x !== 'candidate_disabled' || !c.enabled,
                                  );
                                  const rowBusy = busy === `${v.id}::${c.id}`;
                                  return (
                                    <tr key={c.id}>
                                      <td className="td font-mono break-all">
                                        {c.model}
                                        {c.pinned && (
                                          <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                                            · 置顶
                                          </span>
                                        )}
                                        {inPool && !c.pinned && (
                                          <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                                            · 轮转池
                                          </span>
                                        )}
                                      </td>
                                      <td className="td" style={{ color: 'var(--rg-text-secondary)' }}>
                                        {c.providerLabel || c.provider}
                                      </td>
                                      <td className="td cell-num font-mono">{c.priority}</td>
                                      <td className="td cell-num font-mono">
                                        {inPool ? c.weight : '—'}
                                      </td>
                                      <td className="td cell-num font-mono">{formatRate(c.rate)}</td>
                                      <td className="td cell-num font-mono">
                                        {c.contextWindow ? formatNumber(c.contextWindow) : '—'}
                                      </td>
                                      <td className="td">
                                        {!c.enabled ? (
                                          <Chip tone="neutral">已停用</Chip>
                                        ) : coolingNow ? (
                                          <Chip tone="warn" dot="dot-cool">
                                            冷却 {formatDuration(c.cooldownRemainingMs)}
                                          </Chip>
                                        ) : c.usable === false ? (
                                          <Chip tone="warn">
                                            {reasons.length
                                              ? reasons.map((x) => REASON_TEXT[x] ?? x).join('、')
                                              : '不可用'}
                                          </Chip>
                                        ) : (
                                          <Chip tone="ok" dot="dot-ok">
                                            可用
                                          </Chip>
                                        )}
                                      </td>
                                      <td className="td cell-act">
                                        <div className="inline-flex items-center gap-1.5">
                                          <Button
                                            size="sm"
                                            disabled={rowBusy}
                                            onClick={() =>
                                              patchCandidateFlags(v.id, c.id, { enabled: !c.enabled })
                                            }
                                          >
                                            {c.enabled ? '禁用' : '启用'}
                                          </Button>
                                          <Button
                                            size="sm"
                                            disabled={rowBusy || !c.enabled}
                                            onClick={() =>
                                              patchCandidateFlags(v.id, c.id, { pinned: !c.pinned })
                                            }
                                          >
                                            {c.pinned ? '取消置顶' : '置顶'}
                                          </Button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {(overview.data?.health ?? []).length > 0 && (
          <Panel title="候选健康明细" description="按候选记录的成功率、延迟与最近错误" flush>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">虚拟模型</th>
                  <th className="th">候选</th>
                  <th className="th cell-num">成功</th>
                  <th className="th cell-num">失败</th>
                  <th className="th cell-num">成功率</th>
                  <th className="th cell-num">平均延迟</th>
                  <th className="th">状态</th>
                  <th className="th">最近错误</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.health ?? []).map((h) => (
                  <tr key={`${h.virtualId}-${h.candidateId}`} className="row-hover">
                    <td className="td font-mono text-[12px]">{h.virtualId}</td>
                    <td className="td font-mono text-[12px]">{h.candidateId}</td>
                    <td className="td cell-num">{h.ok}</td>
                    <td className="td cell-num">{h.fail}</td>
                    <td className="td cell-num">
                      {h.successRate == null ? '—' : `${(h.successRate * 100).toFixed(1)}%`}
                    </td>
                    <td className="td cell-num">{h.avgLatencyMs == null ? '—' : formatDuration(h.avgLatencyMs)}</td>
                    <td className="td">
                      {h.cooling ? (
                        <Chip tone="warn" dot="dot-cool">
                          冷却 {formatDuration(h.cooldownRemainingMs)}
                        </Chip>
                      ) : (
                        <Chip tone="ok" dot="dot-ok">
                          正常
                        </Chip>
                      )}
                    </td>
                    <td className="td font-mono text-[11px] break-all">{h.lastError || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <Note>
          自动分层的候选由网关按模型目录的上下文窗口生成，面板可逐个禁用或置顶；
          这些手工调整会被后台的自动分层同步保留，不会被覆盖。
        </Note>
      </Stack>
    </PageShell>
  );
}