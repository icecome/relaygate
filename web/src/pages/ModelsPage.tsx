import { useCallback, useEffect, useState } from 'react';
import StatCard from '../components/StatCard';
import Modal from '../components/Modal';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { getModelsStatus, probeModel, testChat, type ModelInfo } from '../api/admin';
import { strategyLabel, availabilityLabel, functionLabel, fmtBalance } from '../lib/format';

const SCENE_LABELS: Record<string, string> = { coding: '编程', chat: '对话', fast: '快速', reasoning: '深度推理' };

export default function ModelsPage() {
  const { key } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<{
    strategy?: string;
    upstreamFunction?: string;
    data?: ModelInfo[];
    source?: string;
    syncedAt?: string;
    hostNote?: string;
    upstreamChatPath?: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // T3 测试弹窗
  const [testModel, setTestModel] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState('ping');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; content?: string; durationMs?: number; message?: string; usage?: { total_tokens?: number } } | null>(null);

  const load = useCallback(
    (refreshFlag = false) => {
      if (!key) {
        setErr('未配置访问密钥');
        return;
      }
      getModelsStatus({ refresh: refreshFlag }, key)
        .then(setData)
        .catch((e: Error) => setErr(e.message));
    },
    [key],
  );

  useEffect(() => {
    load();
  }, [load]);

  const unavail = (data?.data ?? []).filter((m) => m.status === 'unavailable').length;
  const rows = useCallback(() => {
    const rank: Record<string, number> = { usable: 0, available: 0, unknown: 1, unavailable: 2 };
    return (data?.data ?? [])
      .slice()
      .sort((a, b) => (rank[a.status ?? ''] ?? 1) - (rank[b.status ?? ''] ?? 1) || String(a.id).localeCompare(String(b.id)));
  }, [data]);
  const list = rows();

  async function probe(id: string) {
    try {
      const r = await probeModel(id, key);
      toast(r.ok ? `探活成功 ${id}` : `探活失败：${r.message}`, r.ok ? 'ok' : 'err');
      load();
    } catch (e) {
      toast(`探活失败：${(e as Error).message}`, 'err');
    }
  }

  async function copyModelId(id: string) {
    try {
      if (!navigator.clipboard) throw new Error('当前环境不支持剪贴板写入（需 HTTPS 或 localhost）');
      await navigator.clipboard.writeText(id);
      toast('已复制模型名', 'ok');
    } catch (e) {
      toast(`复制失败：${(e as Error).message}`, 'err');
    }
  }

  // T3：一键测试请求
  function openTest(id: string) {
    setTestModel(id);
    setTestMessage('ping');
    setTestResult(null);
  }

  async function runTest() {
    if (!testModel || !key) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await testChat({ model: testModel, message: testMessage, max_tokens: 64 }, key);
      setTestResult({ ok: r.ok, content: r.content, durationMs: r.durationMs, message: r.message, usage: r.usage });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTestBusy(false);
    }
  }

  // T9：按 scene 分组推荐
  const sceneGroups = useCallback(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of data?.data ?? []) {
      if (m.status === 'unavailable') continue;
      const sc = m.scene || (m.reasoning ? 'reasoning' : 'chat');
      if (!groups[sc]) groups[sc] = [];
      if (groups[sc].length < 2) groups[sc].push(m);
    }
    return groups;
  }, [data]);
  const scenes = sceneGroups();

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard label="调度策略" value={strategyLabel(data?.strategy)} hint="账号池调度策略" />
        <StatCard label="上游函数" value={functionLabel(data?.upstreamFunction)} hint="使用模型配置映射" />
        <StatCard
          label="不可用模型"
          value={unavail}
          hint={
            data?.source
              ? `数据源：${data.source === 'upstream' ? 'Trae 上游 get_detail_param' : data.source === 'local' ? '本地配置' : data.source}${data.syncedAt ? ` · ${data.syncedAt.slice(11, 19)}Z` : ''}`
              : '—'
          }
          accent="warn"
        />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="btn btn-ghost" onClick={() => load(true)}>
          刷新模型列表
        </button>
        <span className="ml-auto text-xs text-ink-faint tabular-nums">
          {data?.hostNote || '模型来源：Trae CN + WorkBuddy CN'}
        </span>
      </div>

      {/* T9 场景推荐卡片 */}
      {Object.keys(scenes).length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {Object.entries(scenes).map(([sc, models]) => (
            <div key={sc} className="card p-4">
              <div className="text-xs font-medium text-ink-soft mb-2.5">{SCENE_LABELS[sc] || sc}</div>
              {models.map((m) => (
                <div key={m.id} className="flex items-center justify-between py-1.5">
                  <span className="text-[13px] text-ink font-medium truncate">{m.display_name || m.id}</span>
                  <button
                    type="button"
                    className="btn-quiet text-xs shrink-0 ml-2"
                    onClick={() => {
                      void copyModelId(m.id);
                    }}
                  >
                    复制
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] min-w-[860px]">
            <thead>
              <tr>
                <th className="th">模型</th>
                <th className="th">来源</th>
                <th className="th">可用性</th>
                <th className="th">类型</th>
                <th className="th cell-num">倍率</th>
                <th className="th" title="两平台官方接口均未提供峰谷价格">峰谷</th>
                <th className="th cell-act">上游路径</th>
              </tr>
            </thead>
            <tbody>
              {err ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-ink-soft">
                    {err}
                  </td>
                </tr>
              ) : !list.length ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-ink-soft">
                    无模型
                  </td>
                </tr>
              ) : (
                list.map((m) => {
                  const st = m.status || 'unknown';
                  const pillCls = st === 'usable' || st === 'available' ? 'pill-ok' : st === 'unavailable' ? 'pill-muted' : 'pill-warn';
                  const id = String(m.id || '');
                  const title = m.display_name && String(m.display_name) !== id ? m.display_name : id;
                  let cap = m.multimodal ? '多模态' : m.reasoning || m.capability === 'reasoning_model' ? '推理' : '';
                  if (m.custom) cap = cap ? `${cap} · 自定义` : '自定义';
                  return (
                    <tr key={id} className="row-hover">
                      <td className="td">
                        <span className="font-medium text-ink">{title}</span>
                        <div className="acct-id">{id}</div>
                      </td>
                      <td className="td text-ink-faint">{m.source_name || (m.owned_by === 'workbuddy' ? 'WorkBuddy CN' : 'Trae CN')}</td>
                      <td className="td">
                        <span className={pillCls} title={m.reason}>
                          {availabilityLabel(st)}
                        </span>
                      </td>
                      <td className="td text-ink-faint">
                        {(m.capability || '') + (cap ? ` · ${cap}` : '')}
                      </td>
                      <td className="td cell-num">{m.rateText ? fmtBalance(Number(m.rateText.replace(/[^\d.]/g, ''))) : '—'}</td>
                      <td className="td text-ink-faint" title="两平台官方接口均未提供峰谷价格">
                        —
                      </td>
                      <td className="td cell-act text-ink-faint">
                        <span className="font-mono text-xs">{data?.upstreamChatPath || '—'}</span>
                        <span className="ml-1.5">
                          <button type="button" className="btn-quiet text-xs" onClick={() => probe(id)}>
                            探活
                          </button>
                          <button type="button" className="btn-quiet text-xs ml-1" onClick={() => openTest(id)}>
                            测试
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* T3 测试弹窗 */}
      <Modal
        open={!!testModel}
        onClose={() => setTestModel(null)}
        title={`测试模型：${testModel || ''}`}
        desc="发送一条真实测试消息到上游（会消耗少量积分）。"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setTestModel(null)}>关闭</button>
            <button type="button" className="btn btn-primary" onClick={runTest} disabled={testBusy || !testMessage.trim()}>
              {testBusy ? '测试中…' : '发送测试'}
            </button>
          </>
        }
      >
        <label className="block text-xs font-medium text-ink-soft mb-1" htmlFor="test-msg">测试消息</label>
        <input id="test-msg" className="field w-full mb-3" value={testMessage} onChange={(e) => setTestMessage(e.target.value)} placeholder="ping" />
        {testResult && (
          <div className={`rounded-md p-3 text-[13px] ${testResult.ok ? 'bg-acc-soft text-acc-hover' : 'bg-danger-soft text-danger'}`}>
            {testResult.ok ? (
              <>
                <div className="mb-1">测试成功 · 耗时 {testResult.durationMs}ms{testResult.usage?.total_tokens ? ` · ${testResult.usage.total_tokens} tokens` : ''}</div>
                <div className="text-ink text-xs max-h-[160px] overflow-y-auto whitespace-pre-wrap">{testResult.content || '(空响应)'}</div>
              </>
            ) : (
              <div>测试失败：{testResult.message}</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}