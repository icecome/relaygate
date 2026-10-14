/**
 * 新增虚拟模型弹窗。
 *
 * 后端写入接口 PUT /v1/admin/model-router/virtual/:id 早已存在，但面板此前只提供
 * 停用 / 解冻 / 删除，没有任何创建入口——虚拟模型只能手改 model-router.json。
 * 本弹窗补上这一入口。
 *
 * 只做「手动」虚拟模型（auto=false）：候选由人显式挑选。
 * 自动分层模型由「同步自动分层」按上游目录窗口生成，不走此表单。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  getAvailableModels,
  upsertVirtual,
  type RouterCandidate,
  type VirtualModel,
} from '../../shared/api/modelRouter';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

/** 表单内的候选草稿：只暴露用户需要填的字段，其余交给后端归一。 */
interface Draft {
  provider: string;
  model: string;
  priority: number;
  weight: number;
  contextWindow: string;
}

const EMPTY_DRAFT: Draft = { provider: '', model: '', priority: 100, weight: 1, contextWindow: '' };

function toCandidate(d: Draft): RouterCandidate {
  return {
    // 候选 id 由后端 normalize 兜底生成（provider:model），此处不预置，
    // 避免同一候选重复保存后 id 漂移导致健康度记录失联。
    id: '',
    provider: d.provider,
    model: d.model,
    priority: Number.isFinite(d.priority) ? d.priority : 100,
    weight: Number.isFinite(d.weight) && d.weight > 0 ? d.weight : 1,
    enabled: true,
    contextWindow: d.contextWindow ? Number(d.contextWindow) : null,
  } as RouterCandidate;
}

export function VirtualModelDialog({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { key } = useAuth();
  const toast = useToast();

  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState<'priority' | 'weighted'>('priority');
  const [contextWindow, setContextWindow] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([{ ...EMPTY_DRAFT }]);
  const [catalog, setCatalog] = useState<Record<string, { id: string; label: string }[]>>({});
  const [busy, setBusy] = useState(false);

  // 打开时重置表单并拉取候选模型目录。
  useEffect(() => {
    if (!open) return;
    setId('');
    setDescription('');
    setStrategy('priority');
    setContextWindow('');
    setDrafts([{ ...EMPTY_DRAFT }]);
    let alive = true;
    getAvailableModels(key)
      .then((r) => {
        if (alive) setCatalog(r.data ?? {});
      })
      .catch(() => {
        // 目录取不到不阻断新建：openai 兼容 Provider 本就可能返回空目录，允许手填
        if (alive) setCatalog({});
      });
    return () => {
      alive = false;
    };
  }, [open, key]);

  /** 候选所在 Provider 的可选模型；openai 兼容端点可能没有目录，需允许手填。 */
  const modelsOf = useMemo(() => {
    return (provider: string) => catalog[provider] ?? [];
  }, [catalog]);

  function patchDraft(idx: number, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function move(idx: number, delta: number) {
    setDrafts((prev) => {
      const next = prev.slice();
      const t = idx + delta;
      if (t < 0 || t >= next.length) return prev;
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });
  }

  async function submit() {
    const vmId = id.trim();
    if (!vmId) {
      toast('请填写虚拟模型 ID', 'warn');
      return;
    }
    const valid = drafts.filter((d) => d.provider.trim() && d.model.trim());
    if (!valid.length) {
      toast('至少需要一个候选（上游 + 模型）', 'warn');
      return;
    }
    if (valid.length !== drafts.length) {
      toast('存在未填完整的候选行，请补齐或删除', 'warn');
      return;
    }
    const body: Partial<VirtualModel> = {
      enabled: true,
      description: description.trim(),
      strategy,
      auto: false,
      contextWindow: contextWindow ? Number(contextWindow) : null,
      candidates: valid.map(toCandidate),
    };
    setBusy(true);
    try {
      await upsertVirtual(vmId, body, key);
      toast(`虚拟模型 ${vmId} 已创建`, 'ok');
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '创建失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新增虚拟模型"
      desc="把一个对外模型名映射到多个上游候选；限流或故障时按候选顺序自动切换"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <Field
            label="模型 ID（对外暴露名）"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如 vm/long-context"
            aria-label="虚拟模型 ID"
          />
          <Field
            label="描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="长上下文分层"
            aria-label="虚拟模型描述"
          />
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
              候选选择策略
            </span>
            <select
              className="field w-full"
              value={strategy}
              aria-label="候选选择策略"
              onChange={(e) => setStrategy(e.target.value === 'weighted' ? 'weighted' : 'priority')}
            >
              <option value="priority">优先级（数字小的先试）</option>
              <option value="weighted">加权轮转（按权重随机）</option>
            </select>
          </div>
          <Field
            label="声明上下文窗口（token，可留空）"
            value={contextWindow}
            inputMode="numeric"
            onChange={(e) => setContextWindow(e.target.value)}
            placeholder="200000"
            aria-label="声明上下文窗口"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
              候选（按顺序尝试，失败自动切换下一个）
            </span>
            <Button size="sm" onClick={() => setDrafts((p) => [...p, { ...EMPTY_DRAFT }])}>
              添加候选
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {drafts.map((d, i) => {
              const options = modelsOf(d.provider);
              return (
                <div
                  key={i}
                  className="grid gap-2 items-end"
                  style={{ gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.4fr) 88px 76px 84px auto' }}
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                      上游
                    </span>
                    <select
                      className="field w-full"
                      value={d.provider}
                      aria-label={`候选 ${i + 1} 上游`}
                      onChange={(e) => patchDraft(i, { provider: e.target.value, model: '' })}
                    >
                      <option value="">选择上游…</option>
                      {Object.keys(catalog).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                      上游模型
                    </span>
                    {options.length ? (
                      <select
                        className="field w-full"
                        value={d.model}
                        aria-label={`候选 ${i + 1} 上游模型`}
                        onChange={(e) => patchDraft(i, { model: e.target.value })}
                      >
                        <option value="">选择模型…</option>
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="field w-full"
                        value={d.model}
                        aria-label={`候选 ${i + 1} 上游模型`}
                        placeholder="上游无目录时手动输入模型名"
                        onChange={(e) => patchDraft(i, { model: e.target.value })}
                      />
                    )}
                  </div>
                  <Field
                    label="优先级"
                    type="number"
                    value={Number.isFinite(d.priority) ? d.priority : 100}
                    aria-label={`候选 ${i + 1} 优先级`}
                    onChange={(e) => patchDraft(i, { priority: Number(e.target.value) })}
                  />
                  <Field
                    label="权重"
                    type="number"
                    value={Number.isFinite(d.weight) ? d.weight : 1}
                    aria-label={`候选 ${i + 1} 权重`}
                    onChange={(e) => patchDraft(i, { weight: Number(e.target.value) })}
                  />
                  <Field
                    label="窗口"
                    type="number"
                    value={d.contextWindow}
                    placeholder="继承"
                    aria-label={`候选 ${i + 1} 上下文窗口`}
                    onChange={(e) => patchDraft(i, { contextWindow: e.target.value })}
                  />
                  <div className="inline-flex items-center gap-1 pb-1">
                    <Button size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移候选">
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      disabled={i === drafts.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="下移候选"
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={drafts.length === 1}
                      onClick={() => setDrafts((p) => p.filter((_, x) => x !== i))}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Note>
          「声明上下文窗口」用于请求分发前的输入超限拦截（超过窗口 75% 直接返回
          400 context_length_exceeded），避免上游静默截断导致早期记忆丢失；
          留空则不拦截。候选级窗口留空时继承该声明。
        </Note>
      </div>
    </Modal>
  );
}
