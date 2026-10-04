import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import StatCard from '../components/StatCard';
import Modal from '../components/Modal';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import {
  getRouterOverview,
  upsertVirtual,
  deleteVirtual,
  unfreezeVirtual,
  upsertProvider,
  getAvailableModels,
  type RouterOverview,
  type VirtualModel,
  type RouterProvider,
  type RouterCandidate,
  type ModelOption,
} from '../api/modelRouter';

/**
 * 编辑期的候选：在 RouterCandidate 之上挂一个仅存在于前端的 uid。
 * 候选 id 会随输入实时变化、priority 会因归位而重排，二者都不能当 React key；
 * uid 在候选被创建时确定，重排后随数据一起移动，输入焦点才不会跟错行。
 * 保存时按字段显式映射，uid 不会进入请求体。
 */
type EditCandidate = RouterCandidate & { uid: string };

type EditVirtual = Omit<VirtualModel, 'candidates'> & { candidates: EditCandidate[] };

let uidSeq = 0;
const nextUid = () => `c${++uidSeq}`;

/** 判定「焦点交给了真正的交互控件」：用于区分用户主动切换与点空白处的被动失焦 */
const USER_TARGET = 'input,select,textarea,button,a[href],[tabindex]:not([tabindex="-1"])';

const emptyCandidate = (provider: string): EditCandidate => ({
  uid: nextUid(),
  id: '',
  provider,
  model: '',
  priority: 1,
  weight: 1,
  maxRpm: null,
  enabled: true,
});

/** 候选 id：未手填时按 provider:model 生成 */
function autoCandidateId(c: RouterCandidate): string {
  return c.id && !c.id.includes(':') ? c.id : `${c.provider}:${c.model || 'model'}`;
}

/**
 * 优先级升序重排（与 orderCandidates 的实际取用顺序一致）。
 * priority 相同时按 id 稳定排序，避免不同优先级相撞时表格抖动。
 */
function sortByPriority<T extends RouterCandidate>(list: T[]): T[] {
  return list.slice().sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));
}

/** 重排后把 priority 归一为 1..n，保证新增候选不会与既有值相撞 */
function renumberPriority<T extends RouterCandidate>(list: T[]): T[] {
  return list.map((c, i) => (c.priority === i + 1 ? c : { ...c, priority: i + 1 }));
}

/**
 * 归位：按优先级升序排列。
 * 出现重复或非法值（清空得到 0）时归一为 1..n，
 * 否则保留用户设定的稀疏值（如 1/5/10）。
 */
function settlePriority<T extends RouterCandidate>(list: T[]): T[] {
  const sorted = sortByPriority(list);
  const dirty =
    new Set(sorted.map((c) => c.priority)).size !== sorted.length ||
    sorted.some((c) => !Number.isFinite(c.priority) || c.priority <= 0);
  return dirty ? renumberPriority(sorted) : sorted;
}

function emptyVirtual(defaultProvider = 'trae'): EditVirtual {
  return {
    id: '',
    enabled: true,
    description: '',
    strategy: 'priority',
    contextWindow: null,
    candidates: [emptyCandidate(defaultProvider)],
    failover: { maxAttempts: 3, switchOn: ['rate_limit', 'model', '5xx', 'network', 'other'], cooldownMs: 20000 },
  };
}

export default function ModelRouterPage() {
  const { key } = useAuth();
  const toast = useToast();
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

  /** 行标识用 uid：候选 id 会随输入变化，拿它比对位次会误判成「换位」 */
  const rowKey = (c: EditCandidate) => c.uid;

  /** 比对重排前后位次，把换了位置的候选标记出来 */
  function markMoved(before: EditCandidate[], after: EditCandidate[]) {
    const idx = new Map(before.map((c, i) => [rowKey(c), i]));
    const changed = after.filter((c, i) => idx.has(rowKey(c)) && idx.get(rowKey(c)) !== i).map(rowKey);
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

  function modelsOf(provider: string): ModelOption[] {
    return modelCatalog[provider] || [];
  }

  /** 自定义模型（下拉里没有的）也要保留在选项里，避免编辑时“选不中” */
  function modelOptions(provider: string, current: string): ModelOption[] {
    const list = modelsOf(provider).slice();
    if (current && !list.some((m) => m.id === current)) {
      list.unshift({ id: current, label: `${current}（自定义）` });
    }
    return list;
  }

  function patchCandidate(i: number, patch: Partial<RouterCandidate>) {
    if (!editing) return;
    const next = editing.candidates.slice();
    const merged = { ...next[i], ...patch };
    // Provider/模型变化时，若 id 仍是自动值则跟随更新
    if ((patch.provider || patch.model) && (!next[i].id || next[i].id === autoCandidateId(next[i]))) {
      merged.id = autoCandidateId(merged);
    }
    next[i] = merged;
    // 不在此处重排：边输入边换位会让输入框失焦，无法连续改数字
    setEditing({ ...editing, candidates: next });
  }

  /** 只按优先级归位，不改写用户设定的数值 */
  function setCandidates(list: EditCandidate[]) {
    if (!editing) return;
    const before = editing.candidates;
    const after = sortByPriority(list);
    markMoved(before, after);
    setEditing({ ...editing, candidates: after });
  }

  /**
   * 优先级失焦提交：按新值归位，重复/非法值归一为 1..n。
   * 归位真的挪动了行、且焦点不是被用户主动交给别的控件时，把焦点还给同一个输入框：
   * 行换了位次，人的注意力不该被甩掉。行以 uid 作 key，重排时 React 移动的是同一个
   * DOM 节点，因此可直接复用该元素，无需按位次重新查找。
   */
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
        <div className="text-sm font-semibold text-ink">虚拟模型</div>
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
                  <div className="ml-auto flex gap-2">
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
                          <td className="td">
                            <span className={`pill ${c.usable ? 'pill-ok' : 'pill-muted'}`}>
                              {c.usable ? '可用' : (c.reasons || []).join(',') || '不可用'}
                            </span>
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
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={data?.virtualModels.some((v) => v.id === editId) ? '编辑虚拟模型' : '新建虚拟模型'}
        desc="虚拟模型是客户端请求的统一入口，内部按候选顺序路由到远端模型。"
        size="xl"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={saveVirtual}>保存</button>
          </>
        }
      >
        {editing && (
          <div className="space-y-5">
            {/* 基本配置 */}
            <section className="space-y-3">
              <h3 className="text-[12.5px] font-semibold text-ink">基本配置</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block" htmlFor="vm-id">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">模型 ID（唯一请求入口）</span>
                  <input
                    id="vm-id"
                    className="field w-full font-mono"
                    value={editId}
                    onChange={(e) => setEditId(e.target.value)}
                    placeholder="vm/my-coder"
                    spellCheck={false}
                  />
                </label>
                <label className="block" htmlFor="vm-desc">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">描述</span>
                  <input
                    id="vm-desc"
                    className="field w-full"
                    value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    placeholder="用途说明，例如：统一对话入口"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="flex flex-col justify-end">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">状态</span>
                  <label className="flex items-center gap-2 h-9 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      className="accent-acc"
                      checked={editing.enabled}
                      onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                    />
                    启用
                  </label>
                </div>
                <label className="block" htmlFor="vm-strategy">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">调度策略</span>
                  <select
                    id="vm-strategy"
                    className="field w-full"
                    value={editing.strategy}
                    onChange={(e) => setEditing({ ...editing, strategy: e.target.value as 'priority' | 'weighted' })}
                  >
                    <option value="priority">优先级（数字小先用）</option>
                    <option value="weighted">权重（按比例分流）</option>
                  </select>
                </label>
                <label className="block" htmlFor="vm-context-window">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">上下文窗口（token）</span>
                  <input
                    id="vm-context-window"
                    type="number"
                    min={0}
                    step={1000}
                    className="field w-full tabular-nums"
                    value={editing.contextWindow ?? ''}
                    onChange={(e) =>
                      setEditing({ ...editing, contextWindow: e.target.value === '' ? null : Number(e.target.value) })
                    }
                    placeholder="留空则不设守门"
                  />
                </label>
                <label className="block" htmlFor="vm-max-attempts">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">最大尝试次数</span>
                  <input
                    id="vm-max-attempts"
                    type="number"
                    min={1}
                    className="field w-full tabular-nums"
                    value={editing.failover.maxAttempts}
                    onChange={(e) =>
                      setEditing({ ...editing, failover: { ...editing.failover, maxAttempts: Number(e.target.value) || 3 } })
                    }
                  />
                </label>
                <label className="block" htmlFor="vm-cooldown">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">冷却时长（ms）</span>
                  <input
                    id="vm-cooldown"
                    type="number"
                    className="field w-full tabular-nums"
                    value={editing.failover.cooldownMs}
                    onChange={(e) =>
                      setEditing({ ...editing, failover: { ...editing.failover, cooldownMs: Number(e.target.value) || 20000 } })
                    }
                  />
                </label>
              </div>
            </section>

            {/* 候选列表 */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[12.5px] font-semibold text-ink">候选远端模型</h3>
                <span className="text-[11.5px] text-ink-faint">
                  {editing.strategy === 'priority'
                    ? '按优先级升序排列，数字小的先用 · 改数字后失焦即归位 · maxRpm 留空表示不限'
                    : '按权重随机分流，优先级仅作为平局裁决 · maxRpm 留空表示不限'}
                </span>
              </div>

              <div className="border border-line-hairline rounded-card overflow-hidden">
                <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_78px_78px_96px_56px] gap-2 items-center px-3 py-2 bg-surf-soft border-b border-line-hairline text-[11.5px] font-medium text-ink-soft">
                  <span>Provider</span>
                  <span>远端模型</span>
                  <span className="text-right">优先级</span>
                  <span className="text-right">权重</span>
                  <span className="text-right">maxRpm</span>
                  <span className="text-right">操作</span>
                </div>

                {!editing.candidates.length ? (
                  <div className="px-3 py-8 text-center text-[12.5px] text-ink-soft">
                    暂无候选，至少添加一个才能保存
                  </div>
                ) : (
                  editing.candidates.map((c, i) => {
                    const opts = modelOptions(c.provider, c.model);
                    // 与行同源用 uid：行会重排，下标会变，id 跟着变会让 label/datalist 关联错行
                    const listId = `mr-models-${c.uid}`;
                    const known = modelsOf(c.provider).length;
                    return (
                      <div
                        // key 用 uid：候选 id 会随输入实时变化，priority 会因归位而重排，
                        // 两者都不能标识「同一行」。uid 随数据移动，重排后 DOM 节点跟着走，
                        // 正在编辑的输入框（及其焦点）不会被顶到别的候选上。
                        key={c.uid}
                        className={`grid grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_78px_78px_96px_56px] gap-2 items-center px-3 py-2.5 border-b border-line-hairline last:border-b-0 transition-colors duration-500 ${
                          moved.has(rowKey(c)) ? 'bg-acc-soft' : ''
                        }`}
                      >
                        <select
                          className="field w-full"
                          aria-label={`候选 ${i + 1} 的 Provider`}
                          value={c.provider}
                          onChange={(e) => patchCandidate(i, { provider: e.target.value, model: '' })}
                        >
                          {(data?.providers || []).map((p) => (
                            <option key={p.id} value={p.id} disabled={!p.enabled}>
                              {p.label || p.id}{p.enabled ? '' : '（停用）'}
                            </option>
                          ))}
                          {!data?.providers.some((p) => p.id === c.provider) && (
                            <option value={c.provider}>{c.provider}</option>
                          )}
                        </select>

                        <input
                          className="field w-full font-mono"
                          list={listId}
                          value={c.model}
                          aria-label={`候选 ${i + 1} 的远端模型`}
                          placeholder={known ? '选择或输入模型…' : '该 Provider 无模型目录，请手输'}
                          onChange={(e) => patchCandidate(i, { model: e.target.value })}
                        />
                        <datalist id={listId}>
                          {opts.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </datalist>

                        <input
                          type="number"
                          className="field w-full text-right tabular-nums"
                          aria-label={`候选 ${i + 1} 的优先级，数字小先用`}
                          value={c.priority}
                          onChange={(e) => patchCandidate(i, { priority: Number(e.target.value) })}
                          // 失焦时才重排：边输入边换位会让输入框失焦，无法连续改数字
                          onBlur={commitPriority}
                        />
                        <input
                          type="number"
                          className="field w-full text-right tabular-nums"
                          aria-label={`候选 ${i + 1} 的权重`}
                          value={c.weight}
                          onChange={(e) => patchCandidate(i, { weight: Number(e.target.value) })}
                        />
                        <input
                          type="number"
                          className="field w-full text-right tabular-nums"
                          aria-label={`候选 ${i + 1} 的每分钟请求上限，留空不限`}
                          placeholder="不限"
                          value={c.maxRpm ?? ''}
                          onChange={(e) =>
                            patchCandidate(i, { maxRpm: e.target.value === '' ? null : Number(e.target.value) })
                          }
                        />
                        <button
                          type="button"
                          className="btn-quiet justify-self-end"
                          aria-label={`移除候选 ${c.id || c.model || i + 1}`}
                          onClick={() => setCandidates(editing.candidates.filter((_, j) => j !== i))}
                        >
                          移除
                        </button>

                        <div className="col-span-6 flex flex-wrap items-center gap-2 -mt-0.5">
                          <label className="text-[11px] text-ink-faint shrink-0" htmlFor={`mr-cand-id-${c.uid}`}>
                            候选 id
                          </label>
                          <input
                            id={`mr-cand-id-${c.uid}`}
                            className="field h-7 w-56 px-2 text-[11px] font-mono"
                            placeholder={`${autoCandidateId(c)}（留空自动生成）`}
                            value={c.id}
                            spellCheck={false}
                            onChange={(e) => patchCandidate(i, { id: e.target.value })}
                          />
                          {known > 0 && (
                            <span className="text-[11px] text-ink-faint">该 Provider 可选 {known} 个模型，输入可过滤</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                <div className="px-3 py-2.5 bg-surf-soft">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const p = data?.providers.find((x) => x.enabled)?.id || 'trae';
                      // 新候选排在最后：优先级取当前最大值 +1
                      const maxPri = editing.candidates.reduce((m, c) => Math.max(m, Number(c.priority) || 0), 0);
                      setCandidates([...editing.candidates, { ...emptyCandidate(p), priority: maxPri + 1 }]);
                    }}
                  >
                    添加候选
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* Provider 编辑弹窗 */}
      <Modal
        open={!!provEdit}
        onClose={() => setProvEdit(null)}
        title="编辑 Provider"
        desc="Provider 是候选远端模型的来源，内置通道复用本平台账号池，OpenAI 兼容端点走外部服务。"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setProvEdit(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={saveProvider}>保存</button>
          </>
        }
      >
        {provEdit && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block" htmlFor="prov-id">
                <span className="block text-xs font-medium text-ink-soft mb-1.5">ID</span>
                <input
                  id="prov-id"
                  className="field w-full font-mono"
                  value={provId}
                  onChange={(e) => setProvId(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="block" htmlFor="prov-label">
                <span className="block text-xs font-medium text-ink-soft mb-1.5">标签</span>
                <input
                  id="prov-label"
                  className="field w-full"
                  value={provEdit.label}
                  onChange={(e) => setProvEdit({ ...provEdit, label: e.target.value })}
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block" htmlFor="prov-type">
                <span className="block text-xs font-medium text-ink-soft mb-1.5">类型</span>
                <select
                  id="prov-type"
                  className="field w-full"
                  value={provEdit.type}
                  onChange={(e) =>
                    setProvEdit({ ...provEdit, type: e.target.value as 'builtin' | 'openai' })
                  }
                >
                  <option value="builtin">内置</option>
                  <option value="openai">OpenAI 兼容</option>
                </select>
              </label>
              <div className="flex flex-col justify-end">
                <span className="block text-xs font-medium text-ink-soft mb-1.5">状态</span>
                <label className="flex items-center gap-2 h-9 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    className="accent-acc"
                    checked={provEdit.enabled}
                    onChange={(e) => setProvEdit({ ...provEdit, enabled: e.target.checked })}
                  />
                  启用
                </label>
              </div>
            </div>
            {provEdit.type === 'builtin' ? (
              <label className="block" htmlFor="prov-builtin">
                <span className="block text-xs font-medium text-ink-soft mb-1.5">内置通道</span>
                <select
                  id="prov-builtin"
                  className="field w-full"
                  value={provEdit.builtin || 'trae'}
                  onChange={(e) =>
                    setProvEdit({ ...provEdit, builtin: e.target.value as 'trae' | 'workbuddy' })
                  }
                >
                  <option value="trae">trae</option>
                  <option value="workbuddy">workbuddy</option>
                </select>
              </label>
            ) : (
              <>
                <label className="block" htmlFor="prov-baseurl">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">Base URL</span>
                  <input
                    id="prov-baseurl"
                    className="field w-full font-mono"
                    value={provEdit.baseUrl || ''}
                    onChange={(e) => setProvEdit({ ...provEdit, baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                  />
                </label>
                <label className="block" htmlFor="prov-apikey-env">
                  <span className="block text-xs font-medium text-ink-soft mb-1.5">API Key 环境变量名</span>
                  <input
                    id="prov-apikey-env"
                    className="field w-full font-mono"
                    value={provEdit.apiKeyEnv || ''}
                    onChange={(e) => setProvEdit({ ...provEdit, apiKeyEnv: e.target.value })}
                    placeholder="MY_PROVIDER_API_KEY"
                    spellCheck={false}
                  />
                  <span className="block text-[11.5px] text-ink-faint mt-1.5">
                    只填写环境变量名，密钥本身从服务端环境读取，不落库到前端。
                  </span>
                </label>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}