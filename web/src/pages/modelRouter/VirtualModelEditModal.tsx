import type { FocusEvent } from 'react';
import Modal from '../../components/Modal';
import type { RouterOverview, RouterCandidate, ModelOption } from '../../api/modelRouter';
import {
  type EditCandidate,
  type EditVirtual,
  autoCandidateId,
  settlePriority,
  emptyCandidate,
} from './priority';

/**
 * 虚拟模型编辑弹窗（m-36：从 ModelRouterPage 拆出）。
 * 承载基本配置 + 候选远端模型编辑（含优先级失焦归位、焦点保持）。
 * 状态与回调由父组件持有，本组件保持受控形态。
 */

interface Props {
  editing: EditVirtual | null;
  editId: string;
  busy: boolean;
  data: RouterOverview | null;
  modelCatalog: Record<string, ModelOption[]>;
  moved: Set<string>;
  onClose: () => void;
  onSave: () => void;
  onEditIdChange: (id: string) => void;
  onEditingChange: (vm: EditVirtual) => void;
  onCandidatesChange: (list: EditCandidate[]) => void;
  onCommitPriority: (e: FocusEvent<HTMLInputElement>) => void;
}

export default function VirtualModelEditModal({
  editing,
  editId,
  busy,
  data,
  modelCatalog,
  moved,
  onClose,
  onSave,
  onEditIdChange,
  onEditingChange,
  onCandidatesChange,
  onCommitPriority,
}: Props) {
  if (!editing) return null;

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
    const next = editing!.candidates.slice();
    const merged = { ...next[i], ...patch };
    // Provider/模型变化时，若 id 仍是自动值则跟随更新
    if ((patch.provider || patch.model) && (!next[i].id || next[i].id === autoCandidateId(next[i]))) {
      merged.id = autoCandidateId(merged);
    }
    next[i] = merged;
    // 不在此处重排：边输入边换位会让输入框失焦，无法连续改数字
    onEditingChange({ ...editing!, candidates: next });
  }

  /** 只按优先级归位，不改写用户设定的数值 */
  function setCandidates(list: EditCandidate[]) {
    if (!editing) return;
    const after = settlePriority(list);
    onCandidatesChange(after);
  }

  return (
    <Modal
      open={!!editing}
      onClose={onClose}
      title={data?.virtualModels.some((v) => v.id === editId) ? '编辑虚拟模型' : '新建虚拟模型'}
      desc="虚拟模型是客户端请求的统一入口，内部按候选顺序路由到远端模型。"
      size="xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onSave}>保存</button>
        </>
      }
    >
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
                onChange={(e) => onEditIdChange(e.target.value)}
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
                onChange={(e) => onEditingChange({ ...editing, description: e.target.value })}
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
                  onChange={(e) => onEditingChange({ ...editing, enabled: e.target.checked })}
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
                onChange={(e) => onEditingChange({ ...editing, strategy: e.target.value as 'priority' | 'weighted' })}
                disabled={editing.auto}
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
                  onEditingChange({ ...editing, contextWindow: e.target.value === '' ? null : Number(e.target.value) })
                }
                disabled={editing.auto}
                placeholder={editing.auto ? '分层窗口（自动）' : '留空则不设守门'}
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
                  onEditingChange({ ...editing, failover: { ...editing.failover, maxAttempts: Number(e.target.value) || 3 } })
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
                  onEditingChange({ ...editing, failover: { ...editing.failover, cooldownMs: Number(e.target.value) || 20000 } })
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
              {editing.auto
                ? '自动分层虚拟模型：候选由网关按目录上下文窗口生成，仅可启用/禁用；重同步会按最新目录刷新'
                : editing.strategy === 'priority'
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
                      moved.has(c.uid) ? 'bg-acc-soft' : ''
                    }`}
                  >
                    <select
                      className="field w-full"
                      aria-label={`候选 ${i + 1} 的 Provider`}
                      value={c.provider}
                      disabled={editing.auto} onChange={(e) => patchCandidate(i, { provider: e.target.value, model: '' })}
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
                      disabled={editing.auto} onChange={(e) => patchCandidate(i, { model: e.target.value })}
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
                      disabled={editing.auto} onChange={(e) => patchCandidate(i, { priority: Number(e.target.value) })}
                      // 失焦时才重排：边输入边换位会让输入框失焦，无法连续改数字
                      onBlur={onCommitPriority}
                    />
                    <input
                      type="number"
                      className="field w-full text-right tabular-nums"
                      aria-label={`候选 ${i + 1} 的权重`}
                      value={c.weight}
                      disabled={editing.auto} onChange={(e) => patchCandidate(i, { weight: Number(e.target.value) })}
                    />
                    <input
                      type="number"
                      className="field w-full text-right tabular-nums"
                      aria-label={`候选 ${i + 1} 的每分钟请求上限，留空不限`}
                      placeholder="不限"
                      value={c.maxRpm ?? ''}
                      disabled={editing.auto} onChange={(e) =>
                        patchCandidate(i, { maxRpm: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                    <button
                      type="button"
                      className="btn-quiet justify-self-end"
                      aria-label={`移除候选 ${c.id || c.model || i + 1}`}
                      onClick={() => setCandidates(editing.candidates.filter((_, j) => j !== i))}
                      disabled={editing.auto}
                      title={editing.auto ? '自动分层候选不可删除（可取消勾选启用状态）' : '移除候选'}
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
                        disabled={editing.auto} onChange={(e) => patchCandidate(i, { id: e.target.value })}
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
              {editing.auto ? (
                <span className="text-[11px] text-ink-faint">
                  候选为自动生成（共 {editing.candidates.length} 个），保存后由网关重同步刷新，此处只读。
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const prov = data?.providers.find((x) => x.enabled)?.id || 'trae';
                    const maxPri = editing.candidates.reduce((m, c) => Math.max(m, Number(c.priority) || 0), 0);
                    setCandidates([...editing.candidates, { ...emptyCandidate(prov), priority: maxPri + 1 }]);
                  }}
                >
                  添加候选
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
