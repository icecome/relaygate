import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import StatCard from '../components/StatCard';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import {
  getRouterOverview,
  upsertVirtual,
  deleteVirtual,
  unfreezeVirtual,
  upsertProvider,
  getAvailableModels,
  resyncAutoTiers,
  type RouterOverview,
  type VirtualModel,
  type RouterProvider,
} from '../api/modelRouter';
import {
  type EditCandidate,
  type EditVirtual,
  nextUid,
  sortByPriority,
  settlePriority,
  autoCandidateId,
  emptyVirtual,
  USER_TARGET,
} from './modelRouter/priority';
import VirtualModelEditModal from './modelRouter/VirtualModelEditModal';
import ProviderEditModal from './modelRouter/ProviderEditModal';
import type { ModelOption } from '../api/modelRouter';

/**
 * 模型路由页（m-36 拆分后主文件）：
 * - 虚拟模型/Provider 列表与 KPI（本文件）
 * - 虚拟模型编辑弹窗 → modelRouter/VirtualModelEditModal.tsx
 * - Provider 编辑弹窗 → modelRouter/ProviderEditModal.tsx
 * - 优先级归位纯函数 → modelRouter/priority.ts
 */

export default function ModelRouterPage() {
  const { key } = useAuth();
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const [data, setData] = useState<RouterOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditVirtual | null>(null);
  const [editId, setEditId] = useState('');
  const [busy, setBusy] = useState(false);
  const [provEdit, setProvEdit] = useState<RouterProvider | null>(null);
  const [provId, setProvId] = useState('');
  const [modelCatalog, setModelCatalog] = useState<Record<string, ModelOption[]>>({});
  /** 刚被重排的候选 key，用于短暂高亮，让「谁换了位次」可见 */
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const movedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (movedTimer.current) window.clearTimeout(movedTimer.current);
    },
    [],
  );

  /** 比对重排前后位次，把换了位置的候选标记出来 */
  function markMoved(before: EditCandidate[], after: EditCandidate[]) {
    const idx = new Map(before.map((c, i) => [c.uid, i]));
    const changed = after.filter((c, i) => idx.has(c.uid) && idx.get(c.uid) !== i).map((c) => c.uid);
    if (!changed.length) return;
    setMoved(new Set(changed));
    if (movedTimer.current) window.clearTimeout(movedTimer.current);
    movedTimer.current = window.setTimeout(() => setMoved(new Set()), 1000);
  }

  const load = useCallback(() => {
    if (!key) {
      setErr('未配置访问密钥');
      return;
    }
    getRouterOverview(key)
      .then(setData)
      .catch((e: Error) => setErr(e.message));
    getAvailableModels(key)
      .then((r) => setModelCatalog(r.data || {}))
      .catch(() => setModelCatalog({}));
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 优先级失焦提交：按新值归位，重复/非法值归一为 1..n。
   * 归位真的挪动了行、且焦点不是被用户主动交给别的控件时，把焦点还给同一个输入框：
   * 行换了位次，人的注意力不该被甩掉。行以 uid 作 key，重排时 React 移动的是同一个
   * DOM 节点，因此可直接复用该元素，无需按位次重新查找。
   */
  /** 触发网关重新同步自动分层虚拟模型（按当前目录窗口/倍率重写候选）。 */
  async function resyncAuto() {
    if (!key) return;
    setSyncing(true);
    try {
      const r = await resyncAutoTiers(key);
      if (r.ok) {
        const parts = (r.tiers || []).map((tier) => tier.id + ' ' + tier.candidates + '个').join(' · ');
        toast('已重同步自动分层（' + parts + '）', 'ok');
      } else {
        toast('重同步部分失败：' + (r.errors || []).join('；'), 'warn');
      }
      load();
    } catch (e) {
      toast('重同步失败：' + (e as Error).message, 'err');
    } finally {
      setSyncing(false);
    }
  }

  /** 自动分层虚拟模型：仅切换候选启用状态（不改写候选列表，重同步不会恢复被禁用的候选）。 */
  async function toggleAutoCandidate(vmId: string, candId: string, enabled: boolean) {
    if (!key) return;
    try {
      const vm = data?.virtualModels.find((v) => v.id === vmId);
      if (!vm) return;
      const candidates = vm.candidates.map((c) => (c.id === candId ? { ...c, enabled } : c));
      await upsertVirtual(vmId, { auto: true, sort: vm.sort ?? null, candidates } as Partial<VirtualModel>, key);
      toast(candId + (enabled ? ' 已启用' : ' 已禁用'), 'ok');
      load();
    } catch (e) {
      toast('更新候选失败：' + (e as Error).message, 'err');
    }
  }

  function commitPriority(e: FocusEvent<HTMLInputElement>) {
    if (!editing) return;
    const el = e.currentTarget;
    // 点弹窗空白处时焦点落到面板（tabindex=-1）或 body，relatedTarget 非空但不是控件；
    // 只有落到真正的交互控件上（Tab 到别的输入框、点按钮）才算用户主动切换。
    const rt = e.relatedTarget as HTMLElement | null;
    const deliberate = !!rt && rt instanceof HTMLElement && rt.matches(USER_TARGET);
    const before = editing.candidates;
    const after = settlePriority(before);
    const reordered = before.some((c, i) => c.uid !== after[i]?.uid);
    markMoved(before, after);
    setEditing({ ...editing, candidates: after });
    if (!reordered || deliberate) return;
    window.requestAnimationFrame(() => {
      if (el.isConnected) el.focus();
    });
  }

  function openCreate() {
    setEditId(`vm/${Date.now().toString(36)}`);
    const firstProvider = data?.providers.find((p) => p.enabled)?.id || 'trae';
    setEditing(emptyVirtual(firstProvider));
  }

  function openEdit(vm: VirtualModel) {
    setEditId(vm.id);
    // 仅按优先级归位展示，不重写既有数值，避免「打开即改动」
    setEditing({
      ...vm,
      candidates: sortByPriority(vm.candidates.map((c) => ({ ...c, uid: nextUid() }))),
    });
  }

  async function saveVirtual() {
    if (!key || !editing) return;
    const id = editId.trim();
    if (!id) {
      toast('请填写模型 ID', 'err');
      return;
    }
    if (!editing.candidates.length || editing.candidates.some((c) => !c.provider || !c.model)) {
      toast('候选需完整填写 provider 与 model', 'err');
      return;
    }
    setBusy(true);
    try {
      const body: Partial<VirtualModel> = {
        enabled: editing.enabled,
        description: editing.description,
        strategy: editing.strategy,
        contextWindow:
          editing.contextWindow != null && Number(editing.contextWindow) > 0 ? Number(editing.contextWindow) : null,
        // 提交前再归位一次：覆盖「改完数字直接点保存」未触发 onBlur 重排的情况
        candidates: settlePriority(editing.candidates).map((c) => ({
          id: c.id || autoCandidateId(c),
          provider: c.provider,
          model: c.model,
          priority: Number(c.priority) > 0 ? Number(c.priority) : 1,
          weight: Number(c.weight) || 1,
          maxRpm: c.maxRpm != null && c.maxRpm !== ('' as unknown) ? Number(c.maxRpm) : null,
          enabled: c.enabled !== false,
        })),
        failover: editing.failover,
      };
      await upsertVirtual(id, body, key);
      toast('已保存虚拟模型', 'ok');
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function removeVirtual(id: string) {
    if (!key) return;
    try {
      await deleteVirtual(id, key);
      toast('已删除', 'ok');
      load();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }

  async function unfreeze(id: string) {
    if (!key) return;
    try {
      await unfreezeVirtual(id, key);
      toast('已解除冷却', 'ok');
      load();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }

  function openProvider(p: RouterProvider) {
    setProvId(p.id);
    setProvEdit({ ...p });
  }

  async function saveProvider() {
    if (!key || !provEdit) return;
    setBusy(true);
    try {
      await upsertProvider(
        provId.trim(),
        {
          type: provEdit.type,
          builtin: provEdit.builtin,
          label: provEdit.label,
          enabled: provEdit.enabled,
          baseUrl: provEdit.baseUrl,
          apiKeyEnv: provEdit.apiKeyEnv,
          timeoutMs: provEdit.timeoutMs,
        },
        key,
      );
      toast('已保存 Provider', 'ok');
      setProvEdit(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  }

  const healthOf = (vmId: string, candId: string) =>
    data?.health.find((h) => h.virtualId === vmId && h.candidateId === candId);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-block-title font-semibold text-ink">虚拟模型</div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost" onClick={load}>刷新</button>
          <button type="button" className="btn btn-primary" onClick={openCreate}>新建虚拟模型</button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard label="虚拟模型" value={data?.virtualModels.length ?? 0} hint="自定义统一请求入口" />
        <StatCard label="Provider" value={data?.providers.length ?? 0} hint="内置 + 通用 OpenAI 兼容端点" />
        <StatCard
          label="限流冷却中"
          value={(data?.health || []).filter((h) => h.cooling).length}
          hint="自动切换已启用"
          accent="warn"
        />
      </div>

      {err && <div className="panel p-4 text-ink-soft">{err}</div>}

      {/* 虚拟模型列表 */}
      <div className="panel">
        <div className="px-4 py-3 border-b border-line-hairline text-sm font-medium text-ink">虚拟模型</div>
        {!data?.virtualModels.length ? (
          <div className="py-10 text-center text-ink-soft text-sm">尚未创建虚拟模型</div>
        ) : (
          <div className="divide-y divide-line-hairline">
            {data.virtualModels.map((vm) => (
              <div key={vm.id} className="p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{vm.id}</span>
                  <span className={`pill ${vm.enabled ? 'pill-ok' : 'pill-muted'}`}>{vm.enabled ? '启用' : '停用'}</span>
                  <span className="pill pill-warn">{vm.strategy === 'weighted' ? '权重' : '优先级'}</span>
                  {vm.contextWindow != null && (
                    <span className="pill pill-muted" title="声明的上下文窗口；输入粗估超过其 75% 时网关直接拒绝">
                      {Math.round(vm.contextWindow / 1000)}K
                    </span>
                  )}
                  {vm.description && <span className="text-xs text-ink-faint">{vm.description}</span>}
                  {vm.auto && (
                    <span className="pill pill-muted" title="自动分层：候选由网关按目录上下文窗口生成，可重同步">自动分层</span>
                  )}
                  <div className="ml-auto flex gap-2">
                    {vm.auto && (
                      <button type="button" className="btn-quiet text-xs" onClick={resyncAuto} disabled={syncing}>
                        {syncing ? '同步中…' : '重同步分层'}
                      </button>
                    )}
                    <button type="button" className="btn-quiet text-xs" onClick={() => unfreeze(vm.id)}>解除冷却</button>
                    <button type="button" className="btn-quiet text-xs" onClick={() => openEdit(vm)}>编辑</button>
                    <button type="button" className="btn-quiet text-xs text-red-600" onClick={() => removeVirtual(vm.id)}>删除</button>
                  </div>
                </div>
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      {/* 权重策略下取用顺序由权重随机决定，排序列无意义，故只在优先级策略下展示 */}
                      {vm.strategy === 'priority' && (
                        <th className="th w-10 cell-num" scope="col" title="优先级策略下的实际取用次序：数字小的先用">
                          序
                        </th>
                      )}
                      <th className="th" scope="col">候选</th>
                      <th className="th" scope="col">Provider</th>
                      <th className="th" scope="col">远端模型</th>
                      <th className="th cell-num" scope="col" title="策略=优先级时生效：数字小的先用">优先级</th>
                      <th className="th cell-num" scope="col" title="策略=权重时生效：按数值分配流量占比">权重</th>
                      <th className="th cell-num" scope="col" title="该候选每分钟最多请求数；留空不限。本地闸门，降低撞上游限流概率">maxRpm</th>
                      <th className="th cell-num" scope="col" title="候选真实上下文窗口；声明后网关按此做单候选输入守门">窗口</th>
                      <th className="th cell-num" scope="col" title="候选最大输出 token；请求 max_tokens 超过时网关自动钳制">输出</th>
                      <th className="th cell-num" scope="col" title="积分倍率（自动分层排序依据；越低越优先）">倍率</th>
                      <th className="th" scope="col">状态</th>
                      <th className="th cell-num" scope="col">成功率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortByPriority(vm.candidates).map((c, idx) => {
                      const h = healthOf(vm.id, c.id);
                      const rank = idx + 1;
                      return (
                        <tr key={c.id} className="row-hover">
                          {vm.strategy === 'priority' && (
                            <td className="td cell-num tabular-nums">
                              <span className={rank === 1 ? 'font-semibold text-acc' : 'text-ink-faint'}>{rank}</span>
                            </td>
                          )}
                          <td className="td font-mono">{c.id}</td>
                          <td className="td">{c.providerLabel || c.provider}</td>
                          <td className="td font-mono">{c.model}</td>
                          <td className="td cell-num">{c.priority}</td>
                          <td className="td cell-num">{c.weight}</td>
                          <td className="td cell-num">{c.maxRpm ?? '—'}</td>
                          <td className="td cell-num tabular-nums text-ink-soft">
                            {c.contextWindow ? Math.round(c.contextWindow / 1000) + 'K' : '—'}
                          </td>
                          <td className="td cell-num tabular-nums text-ink-soft">
                            {c.maxOutputTokens ? c.maxOutputTokens.toLocaleString() : '—'}
                          </td>
                          <td className="td cell-num tabular-nums text-ink-soft">
                            {c.rate != null ? String(c.rate) : '—'}
                          </td>
                          <td className="td">
                            {vm.auto ? (
                              <label className="inline-flex items-center gap-1 text-[11px] text-ink-faint" title="取消勾选后网关不再路由到该候选；重同步不会自动恢复">
                                <input
                                  type="checkbox"
                                  checked={c.enabled !== false}
                                  onChange={(e) => toggleAutoCandidate(vm.id, c.id, e.target.checked)}
                                />
                                {c.enabled !== false ? '启用' : '已禁用'}
                              </label>
                            ) : (
                              <span className={c.usable ? 'pill pill-ok' : 'pill pill-muted'}>
                                {c.usable ? '可用' : (c.reasons || []).join(',') || '不可用'}
                              </span>
                            )}
                          </td>
                          <td className="td cell-num">
                            {h ? `${h.successRate ?? '—'}%${h.cooling ? ' · 冷却' : ''}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Providers */}
      <div className="panel">
        <div className="px-4 py-3 border-b border-line-hairline text-sm font-medium text-ink">远端 Provider</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] min-w-[720px]">
            <thead>
              <tr>
                <th className="th" scope="col">ID</th>
                <th className="th" scope="col">类型</th>
                <th className="th" scope="col">标签</th>
                <th className="th" scope="col">端点</th>
                <th className="th" scope="col">启用</th>
                <th className="th cell-act" scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {(data?.providers || []).map((p) => (
                <tr key={p.id} className="row-hover">
                  <td className="td font-mono">{p.id}</td>
                  <td className="td">{p.type === 'openai' ? 'OpenAI 兼容' : `内置 · ${p.builtin}`}</td>
                  <td className="td">{p.label}</td>
                  <td className="td font-mono text-xs">{p.baseUrl || '—'}</td>
                  <td className="td">
                    <span className={`pill ${p.enabled ? 'pill-ok' : 'pill-muted'}`}>{p.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td className="td cell-act">
                    <button type="button" className="btn-quiet text-xs" onClick={() => openProvider(p)}>编辑</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 虚拟模型编辑弹窗 */}
      <VirtualModelEditModal
        editing={editing}
        editId={editId}
        busy={busy}
        data={data}
        modelCatalog={modelCatalog}
        moved={moved}
        onClose={() => setEditing(null)}
        onSave={saveVirtual}
        onEditIdChange={setEditId}
        onEditingChange={setEditing}
        onCandidatesChange={(list) => {
          if (!editing) return;
          const before = editing.candidates;
          const after = sortByPriority(list);
          markMoved(before, after);
          setEditing({ ...editing, candidates: after });
        }}
        onCommitPriority={commitPriority}
      />

      {/* Provider 编辑弹窗 */}
      <ProviderEditModal
        provEdit={provEdit}
        provId={provId}
        busy={busy}
        onClose={() => setProvEdit(null)}
        onProvEditChange={setProvEdit}
        onProvIdChange={setProvId}
        onSave={saveProvider}
      />
    </div>
  );
}
