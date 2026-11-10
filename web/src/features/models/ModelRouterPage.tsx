/**
 * 路由与虚拟模型页：上游 Provider、虚拟模型映射与候选健康度。
 * 对应 /v1/admin/model-router/* 真实接口。
 */
import { Fragment, useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  deleteProvider,
  deleteVirtual,
  getRouterOverview,
  getVirtualRouteCheck,
  patchCandidate,
  reloadRouter,
  resyncAutoTiers,
  unfreezeVirtual,
  upsertVirtual,
  type HealthRow,
  type RouterProvider,
  type VirtualRouteCheck,
} from '../../shared/api/modelRouter';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatDuration, formatNumber, percent, platformIdLabel } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
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
import { VirtualModelDialog } from './VirtualModelDialog';
import { ProviderDialog } from './ProviderDialog';
import Modal from '../../shared/ui/Modal';

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
  return `×${rate}`;
}

export default function ModelRouterPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  // 展开的虚拟模型 ID 集合：聚合模型下分配了哪些上游模型，需逐个展开查看
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // 新增虚拟模型弹窗：此前面板只有停用/解冻/删除，创建只能手改 model-router.json
  const [createOpen, setCreateOpen] = useState(false);
  // Provider 新增 / 编辑弹窗：null = 关闭，{ provider: null } = 新建
  const [providerDialog, setProviderDialog] = useState<{ provider: RouterProvider | null } | null>(null);
  // 路由体检结果：把 route-check/:id 的 wouldPick 落到界面，回答「这次会落到谁」
  const [routeCheck, setRouteCheck] = useState<{
    id: string;
    loading: boolean;
    error: string | null;
    data: VirtualRouteCheck | null;
  } | null>(null);

  /** 打开某个虚拟模型的路由体检。不发送真实上游请求，纯解释。 */
  async function openRouteCheck(id: string) {
    setRouteCheck({ id, loading: true, error: null, data: null });
    try {
      const data = await getVirtualRouteCheck(id, key);
      setRouteCheck({ id, loading: false, error: null, data });
    } catch (e) {
      setRouteCheck({
        id,
        loading: false,
        error: e instanceof ApiError ? e.message : '路由体检失败',
        data: null,
      });
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 轮转池大小（rotateTopN）：0 表示不轮转，固定取成本序首选。 */
  async function setRotateTopN(id: string, current: number, next: number) {
    if (next === current || next < 0) return;
    setBusy(id);
    try {
      await upsertVirtual(id, { rotateTopN: next }, key);
      toast(next === 0 ? '已关闭轮转，固定使用排序第一位的候选' : `轮转池已调整为 ${next} 个`, 'ok');
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
      { key: '上游 Provider', value: formatNumber(providers.length) },
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
        // 业务层失败：展示后端原因，不按网络错误处理
        toast(`同步未成功：${r.errors?.join('；') || '网关未返回失败原因；若持续出现，请到「运维 → 定时任务」查看任务日志'}`, 'err');
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
      toast('已解除冷却', 'ok');
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '解除冷却失败', 'err');
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

  /**
   * 删除第三方 Provider。
   * 只对 type=openai 的端点开放：内置 trae/workbuddy 是账号池的落地实现，
   * 后端也会拒绝，面板不给出按钮以免误导。删除会连带清掉引用它的候选。
   */
  async function removeProvider(id: string, label: string) {
    const ok = await prompt({
      title: `删除上游 Provider ${label || id}？`,
      message: '引用该 Provider 的候选会一并移除，此操作不可撤销。',
      okText: '删除',
      danger: true,
    });
    if (ok !== true) return;
    setBusy(`provider:${id}`);
    try {
      await deleteProvider(id, key);
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
        patch.enabled === false ? '已停用该候选' : patch.enabled === true ? '已启用该候选'
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
      description="将对外暴露的模型名映射到多个上游候选，并展示各候选健康度"
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

        <Panel
          title="上游 Provider"
          description="凭据来源与可用模型范围"
          flush
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => setProviderDialog({ provider: null })}>
                新增 Provider
              </Button>
            </>
          }
          footer={
            <>
              第三方端点的密钥不落在 model-router.json：后端只存环境变量名，
              运行时从 <code className="font-mono">process.env[apiKeyEnv]</code> 取。
              填了变量名但没写进 .env 或没重启进程，请求会得到 401「provider 缺少 API Key」。
            </>
          }
        >
          {overview.loading && !overview.data ? (
            <LoadingBlock />
          ) : (overview.data?.providers ?? []).length === 0 ? (
            <EmptyState
              label="尚未配置上游 Provider"
              hint="内置 Provider 由凭据池账号生成；要接外部模型 API，点右上角「新增 Provider」填 Base URL 与环境变量名。"
              action={{ label: '新增 Provider', onClick: () => setProviderDialog({ provider: null }) }}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th">名称</th>
                  <th className="th">类型</th>
                  <th className="th">状态</th>
                  <th className="th">密钥</th>
                  <th className="th cell-num">模型数</th>
                  <th className="th cell-num">超时</th>
                  <th className="th">Base URL</th>
                  <th className="th cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.providers ?? []).map((p) => (
                  <tr key={p.id} className="row-hover">
                    <td className="td">
                      <div className="text-[13px]">{p.label}</div>
                      <div className="font-mono text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {p.id}
                      </div>
                    </td>
                    <td className="td">
                      {p.type === 'builtin' ? (
                        <Chip tone="brand">内置 · {p.builtin ? platformIdLabel(p.builtin) : '—'}</Chip>
                      ) : (
                        <Chip tone="neutral">第三方 OpenAI 兼容接口</Chip>
                      )}
                    </td>
                    <td className="td">
                      <Chip tone={p.enabled ? 'ok' : 'neutral'} dot={p.enabled ? 'dot-ok' : 'dot-off'}>
                        {p.enabled ? '启用' : '已停用'}
                      </Chip>
                    </td>
                    <td className="td td-mono">
                      {p.type === 'builtin' ? (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>使用凭据池账号</span>
                      ) : p.hasApiKey ? (
                        /*
                         * hasApiKey 只代表「填了环境变量名」（store.listProviders
                         * 的 hasApiKey: !!p.apiKeyEnv），不代表进程里这个变量有值。
                         * 措辞必须是「已声明」而不是「已配置」，否则用户会以为
                         * 保存成功就等于密钥可用，然后在 401 里查半天。
                         */
                        <span title="后端只校验变量名是否存在，不校验进程环境里有没有值">
                          {p.apiKeyEnv ?? '已声明'}
                          <span className="ml-1" style={{ color: 'var(--rg-text-tertiary)' }}>
                            · 未验证
                          </span>
                        </span>
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
                    <td className="td font-mono text-aux break-all">{p.baseUrl || '—'}</td>
                    <td className="td cell-act">
                      <div className="td-actions">
                        <Button size="sm" onClick={() => setProviderDialog({ provider: p })}>
                          编辑
                        </Button>
                        {p.type === 'builtin' ? (
                          <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                            内置，不可删除
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === `provider:${p.id}`}
                            onClick={() => removeProvider(p.id, p.label)}
                          >
                            删除
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="虚拟模型"
          description="每个对外模型名对应的候选序列"
          flush
          actions={
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
              新增虚拟模型
            </Button>
          }
          footer="保存可能只成功一部分，此时会在对应表单内显示后端返回的原因。"
        >
          {overview.loading && !overview.data ? (
            <LoadingBlock />
          ) : (overview.data?.virtualModels ?? []).length === 0 ? (
            <EmptyState
              label="尚未创建虚拟模型"
              hint="创建一个对外模型名，并把它映射到若干上游候选，即可让客户端直接调用该名称。"
              action={{ label: '新增虚拟模型', onClick: () => setCreateOpen(true) }}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th">虚拟模型</th>
                  <th className="th">策略</th>
                  <th className="th">生成方式</th>
                  <th className="th">声明上下文窗口</th>
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
                  // 池 = 置顶候选 + 已启用候选按成本序的前 rotateTopN 名；
                  // 已禁用候选不占名额（后端会过滤后按可用列表切池）。
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
                  // 轮转池成员判定。
                  //
                  // ⚠️ 这里是「weighted 策略」与「rotateTopN」两件事的交汇处，曾经
                  // 混成一句，导致一个真实故障：用户选「加权轮转」、给每个候选都填了
                  // 权重，保存后界面上**只有第一个候选**显示权重（其余显示 —），
                  // 而且实际调度也确实只用了第一个 —— 权重完全没生效。
                  //
                  // 根因：manual VM（auto=false）的 rotateTopN 默认是 0，而
                  // `poolSize > 0 ? slice(0,N) : slice(0,1)` 在 0 时只取第一个。
                  // 那句 fallback 原本是为 **priority** 策略写的（优先级策略确实
                  // 固定用第一个候选，其余是降级备胎），但 weighted 策略下
                  // 「池」就是**全部启用的候选** —— 没有池，权重就没有意义。
                  //
                  // 现在按策略分开：
                  //   - weighted：全部启用的候选都在池里（rotateTopN 若显式声明，
                  //     仍按声明截断 —— 那是 autotier 生成模型时的语义）；
                  //   - priority：沿用「取第一个」的旧语义（降级按顺序回退）。
                  const poolSize = v.rotateTopN ?? 0;
                  const weighted = v.strategy === 'weighted';
                  const poolList = weighted && poolSize <= 0
                    ? costSorted
                    : (poolSize > 0 ? costSorted.slice(0, poolSize) : costSorted.slice(0, 1));
                  const poolIds = new Set(poolList.map((c) => c.id));
                  for (const c of v.candidates) if (c.pinned && c.enabled !== false) poolIds.add(c.id);
                  const usableCount = v.candidates.filter((c) => c.usable !== false).length;
                  return (
                    <Fragment key={v.id}>
                      <tr className="row-hover">
                        <td className="td">
                          <div className="font-mono text-aux font-semibold">{v.id}</div>
                          {v.description && (
                            <div className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                              {v.description}
                            </div>
                          )}
                        </td>
                        <td className="td">
                          <Chip tone="brand">{v.strategy === 'weighted' ? '加权轮转' : '优先级'}</Chip>
                          {v.auto && (
                            <div
                              className="mt-1 flex items-center gap-1"
                              title="轮转池大小：按排序取前 N 个候选做加权轮转（sort=rate 时为倍率升序）。0 表示关闭轮转，固定使用排序第一位的候选。"
                            >
                              <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
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
                          {(!v.auto || v.strategy === 'weighted') && poolIds.size > 0 && (
                            <div
                              className="text-aux mt-1"
                              style={{ color: 'var(--rg-text-tertiary)' }}
                              title={
                                v.strategy === 'weighted'
                                  ? '加权轮转：池内全部启用候选按权重随机排序，权重越大越常被排到前面（排第一的候选即本次命中的上游）。'
                                  : '优先级：按优先级升序固定取第一个候选，其余候选仅在失败/限流时按顺序回退。'
                              }
                            >
                              轮转 {poolIds.size} 个候选
                            </div>
                          )}
                        </td>
                        <td className="td">{v.auto ? '自动分层同步' : '手工维护'}</td>
                        <td className="td td-mono">
                          {v.contextWindow ? formatNumber(v.contextWindow) : '未声明窗口'}
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
                            <span style={{ color: 'var(--rg-text-tertiary)' }}>无健康记录</span>
                          ) : (
                            <div className="min-w-[120px]">
                              <ProgressBar ratio={rate} tone={cooling ? 'warn' : 'brand'} />
                              <div className="text-aux mt-1 font-mono" style={{ color: 'var(--rg-text-tertiary)' }}>
                                {cooling
                                  ? `冷却中 · 成功 ${okCount} / ${okCount + failCount}`
                                  : `成功 ${okCount} / ${okCount + failCount}`}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="td cell-act">
                          <div className="td-actions">
                            {/*
                              「试算」= GET /v1/admin/model-router/route-check/:id。
                              这条接口从 2026-10 就存在（routes/model-router.js:145），
                              返回 wouldPick / usableCount / 逐候选 reasons / failover，
                              是「路由混乱」这个问题唯一能从数据上回答的入口。
                              此前面板零调用，用户只能自己数 priority。
                            */}
                            <Button size="sm" disabled={isBusy} onClick={() => void openRouteCheck(v.id)}>
                              试算
                            </Button>
                            <Button size="sm" disabled={isBusy} onClick={() => toggleVirtual(v.id, v.enabled)}>
                              {v.enabled ? '停用' : '启用'}
                            </Button>
                            <Button size="sm" disabled={isBusy || !cooling} onClick={() => unfreeze(v.id)}>
                              解除冷却
                            </Button>
                            <Button size="sm" variant="danger" disabled={isBusy} onClick={() => removeVirtual(v.id)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td className="td" colSpan={7} style={{ background: 'var(--rg-bg-secondary)' }}>
                            {/*
                              嵌套候选表必须自带 table-fixed + 列宽：
                              外层表是 auto 布局（未加 .table-fixed），所以内表若
                              也不定宽，列宽会随「当前展开的候选内容」反推 ——
                              展开不同虚拟模型时整表横向位移，横向滚动条位置也随之跳。
                            */}
                            <table className="data-table table-fixed text-aux">
                              <thead>
                                <tr>
                                  {/* 列宽合计 704px：候选列吃剩余宽度，其余定宽 */}
                                  <th className="th">候选</th>
                                  <th className="th" style={{ width: 120 }}>上游</th>
                                  <th className="th cell-num" style={{ width: 56 }}>优先</th>
                                  <th className="th cell-num" style={{ width: 56 }}>权重</th>
                                  <th className="th cell-num" style={{ width: 72 }}>倍率</th>
                                  <th className="th cell-num" style={{ width: 92 }}>窗口</th>
                                  <th className="th" style={{ width: 168 }}>状态</th>
                                  <th className="th cell-act" style={{ width: 168 }}>操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {v.candidates.map((c) => {
                                  const inPool = poolIds.has(c.id);
                                  const coolingNow =
                                    typeof c.cooldownRemainingMs === 'number' && c.cooldownRemainingMs > 0;
                                  // candidate_disabled 是候选自身的停用开关，已由「状态」列表达；
                                  // 仅在存在其他阻断原因时提示，避免同一事实显示两遍。
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
                                        <div className="td-actions">
                                          <Button
                                            size="sm"
                                            disabled={rowBusy}
                                            onClick={() =>
                                              patchCandidateFlags(v.id, c.id, { enabled: !c.enabled })
                                            }
                                          >
                                            {c.enabled ? '停用' : '启用'}
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
          <Panel title="候选健康明细" description="按候选展示成功率、延迟与最近一次错误" flush>
            <table className="data-table">
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
                    <td className="td td-mono">{h.virtualId}</td>
                    <td className="td td-mono">{h.candidateId}</td>
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
                    <td className="td font-mono text-aux break-all line-clamp-2" title={h.lastError || undefined}>{h.lastError || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <Note>
          自动分层的候选由网关按模型目录的上下文窗口生成，面板可逐个停用或置顶；
          这些手工调整会被后台的自动分层同步保留，不会被覆盖。
          目录中的图片与视频生成模型没有 chat 端点，不进入候选。
        </Note>
      </Stack>

      <VirtualModelDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={overview.reload}
      />

      <ProviderDialog
        open={providerDialog !== null}
        provider={providerDialog?.provider ?? null}
        onClose={() => setProviderDialog(null)}
        onSaved={() => {
          overview.reload();
          // 新增 Provider 后必须重载路由才会写进内存快照；
          // 这里不自动调 reload，避免用户还没建虚拟模型就被动改了运行态
        }}
      />

      {/*
        路由体检结果：把 route-check 的 wouldPick 摊开成三块
        —— 会选谁 / 谁被排除 / 失败怎么切。
      */}
      <Modal
        open={routeCheck !== null}
        onClose={() => setRouteCheck(null)}
        title={`路由试算：${routeCheck?.id ?? ''}`}
        desc="不发真实请求，只按当前配置解释这一跳会落到哪个候选（GET /v1/admin/model-router/route-check/:id）"
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => setRouteCheck(null)}>
            关闭
          </Button>
        }
      >
        {routeCheck?.loading ? (
          <LoadingBlock label="计算中" />
        ) : routeCheck?.error ? (
          <Note tone="danger">{routeCheck.error}</Note>
        ) : routeCheck?.data ? (
          <div className="flex flex-col gap-4">
            <div className="subcard">
              <div className="text-label mb-2">此刻会选中的候选</div>
              {routeCheck.data.wouldPick ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono text-[14px] font-semibold">
                      {routeCheck.data.wouldPick.provider} / {routeCheck.data.wouldPick.model}
                    </span>
                    <Chip tone="ok" dot="dot-ok">
                      可用
                    </Chip>
                    <Chip tone="brand">
                      {routeCheck.data.strategy === 'weighted' ? '加权轮转' : '优先级'}
                    </Chip>
                  </div>
                  <div className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                    可用候选 {routeCheck.data.usableCount} / {routeCheck.data.candidates.length}
                    {typeof routeCheck.data.wouldPick.rate === 'number'
                      ? ` · 倍率 ${formatRate(routeCheck.data.wouldPick.rate)}`
                      : ''}
                    {routeCheck.data.wouldPick.contextWindow
                      ? ` · 窗口 ${formatNumber(routeCheck.data.wouldPick.contextWindow)}`
                      : ''}
                  </div>
                </div>
              ) : (
                <Note tone="danger">
                  没有可用候选：这个虚拟模型当前调用必然失败。检查下面的排除原因，
                  或到「模型池状态」页探测对应上游模型是否真的可用。
                </Note>
              )}
            </div>

            <div>
              <div className="text-label mb-2">逐候选判定</div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="th">候选</th>
                      <th className="th">上游</th>
                      <th className="th cell-num">优先</th>
                      <th className="th cell-num">倍率</th>
                      <th className="th">判定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeCheck.data.candidates.map((c) => {
                      const reasons = (c.reasons ?? []).filter(
                        (x) => x !== 'candidate_disabled' || !c.enabled,
                      );
                      const coolingNow =
                        typeof c.cooldownRemainingMs === 'number' && c.cooldownRemainingMs > 0;
                      return (
                        <tr key={c.id} className="row-hover">
                          <td className="td font-mono text-aux break-all">{c.model}</td>
                          <td className="td text-aux">{c.providerLabel || c.provider}</td>
                          <td className="td cell-num font-mono">{c.priority}</td>
                          <td className="td cell-num font-mono">{formatRate(c.rate)}</td>
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="subcard-soft">
              <div className="text-label mb-1.5">失败切换策略（failover）</div>
              <div className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                最多尝试 <strong>{routeCheck.data.failover.maxAttempts}</strong> 次 ·
                单候选冷却 <strong>{formatDuration(routeCheck.data.failover.cooldownMs)}</strong> ·
                触发切换的错误：{routeCheck.data.failover.switchOn.join(' / ')}
              </div>
            </div>

            <Note>
              这份结果是**此刻**的判定：冷却会随时间解除，账号余额与目录也会变。
              要找「为什么刚才失败」，去「请求日志」看那一行的 routedTo 与错误码，
              不要用本页反推。
            </Note>
          </div>
        ) : null}
      </Modal>
    </PageShell>
  );
}