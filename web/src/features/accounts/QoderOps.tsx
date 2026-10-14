/**
 * Qoder 运营面：每日积分活动领取 + 两段额度。
 *
 * 为什么需要它：后端的 `/v1/qoder/accounts/:id/campaigns|quota|claim` 与
 * `/v1/qoder/run` 一直只有 API。CredentialsPage 此前把「签到」按钮对 Qoder
 * 隐藏（正确，Qoder 没有签到而是活动领取），却也没有提供活动领取入口——
 * 用户看得见账号，却没有任何地方能领今天的 100 积分。
 *
 * 三条必须遵守的口径：
 *   1. **两段额度隔离**：基础 userQuota + 赠送 addOnQuota 同屏分列展示、
 *      合计仅供阅读，**不得**并入任何积分汇总（否则重演 ZCode 那次数级污染）；
 *   2. 上游在**桌面端身份头缺失时不报错但返回空活动列表**，因此「空列表」
 *      与「今日已领」「真没活动」是三件事，UI 必须分开说；
 *   3. 国内版与 qt 外的协议差异：**对话转发仅国际版**，国内版只能领积分。
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import type { ChannelJobs } from '../../shared/api/channels';
import {
  qoderAccounts,
  qoderCampaigns,
  qoderClaim,
  qoderQuota,
  qoderRun,
  qoderSaveSettings,
  type QoderAccount,
  type QoderCampaigns,
  type QoderQuota,
  type QoderRunSummary,
} from '../../shared/api/qoder';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Button, Chip, EmptyState, LoadingBlock, Note } from '../../shared/ui';
import { useToast } from '../../shared/ui/Toast';

interface RowResult {
  tone: 'ok' | 'warn' | 'err';
  text: string;
  campaigns?: QoderCampaigns;
  quota?: QoderQuota;
}

interface JobsForm {
  enabled: boolean;
  autoClaim: boolean;
  hour: number;
  minute: number;
}

function formFrom(jobs: ChannelJobs | null): JobsForm {
  return {
    enabled: jobs?.enabled ?? false,
    autoClaim: jobs?.autoClaim ?? true,
    hour: jobs?.hour ?? 10,
    minute: jobs?.minute ?? 15,
  };
}

function NumInput({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      max={max}
      className="field"
      style={{ width: 56 }}
      value={value}
      aria-label={label}
      onChange={(e) => {
        const n = Number.parseInt(e.target.value, 10);
        onChange(Number.isFinite(n) ? n : 0);
      }}
    />
  );
}

/** 活动状态 → 可读文案与色调。 */
function statusOf(c: { claimStatus: string; actionType: string }): { text: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (c.actionType !== 'CLAIM_BENEFIT') return { text: c.claimStatus || '展示型', tone: 'neutral' };
  if (c.claimStatus === 'CLAIMABLE') return { text: '可领取', tone: 'ok' };
  if (c.claimStatus === 'CLAIMED') return { text: '已领取', tone: 'warn' };
  return { text: c.claimStatus || '—', tone: 'neutral' };
}

export function QoderOps({ jobs, onChanged }: { jobs: ChannelJobs | null; onChanged: () => void }) {
  const { key } = useAuth();
  const toast = useToast();
  const [accounts, setAccounts] = useState<QoderAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [form, setForm] = useState<JobsForm>(() => formFrom(jobs));
  const [batch, setBatch] = useState<QoderRunSummary | null>(null);

  useEffect(() => {
    setForm(formFrom(jobs));
  }, [jobs]);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const r = await qoderAccounts(key);
      setAccounts(r.data ?? []);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取 Qoder 账号失败', 'err');
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [key, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runOn(id: string, label: string, fn: () => Promise<RowResult>) {
    setBusy(`${id}:${label}`);
    try {
      const r = await fn();
      setResults((prev) => ({ ...prev, [id]: r }));
    } catch (e) {
      const text = e instanceof ApiError ? e.message : `${label} 失败`;
      setResults((prev) => ({ ...prev, [id]: { tone: 'err', text } }));
    } finally {
      setBusy(null);
    }
  }

  async function fetchCampaigns(a: QoderAccount) {
    await runOn(a.id, 'campaigns', async () => {
      const r = await qoderCampaigns(a.id, key);
      if (!r.campaigns.length) {
        // 上游头缺失时是「空列表」而非报错，必须把这种可能说出来
        return {
          tone: 'warn',
          text: '上游返回空活动列表：可能是今日确无活动，也可能是桌面端身份头被上游过滤（这类失败不会报错）',
          campaigns: r,
        };
      }
      return {
        tone: r.claimableCampaigns.length ? 'ok' : 'warn',
        text: r.claimableCampaigns.length
          ? `可领取 ${r.claimableCampaigns.length} 个积分活动`
          : '当前没有可领取的积分活动',
        campaigns: r,
      };
    });
  }

  async function claim(a: QoderAccount, campaignId?: string) {
    await runOn(a.id, 'claim', async () => {
      const r = await qoderClaim(a.id, key, campaignId);
      // already_today / no_campaign 都是「没领到」，但原因完全不同，必须分开说
      const tone = r.result === 'claimed' ? 'ok' : r.result === 'failed' ? 'err' : 'warn';
      onChanged();
      void load();
      return { tone, text: r.message || `${r.result}` };
    });
  }

  async function quota(a: QoderAccount) {
    await runOn(a.id, 'quota', async () => {
      const r = await qoderQuota(a.id, key);
      onChanged();
      void load();
      return { tone: 'ok', text: `剩余 ${formatNumber(r.totalRemaining)} credits（两段合计，仅供阅读）`, quota: r };
    });
  }

  async function runBatch(claimIt: boolean) {
    setBusy('__batch__');
    try {
      const r = await qoderRun(key, claimIt);
      setBatch(r);
      toast(
        claimIt
          ? `一轮完成：探测 ${r.probed}，领取 ${r.claimed}，今日已领 ${r.alreadyToday}，空列表 ${r.emptyList}，失败 ${r.failed}`
          : `探测完成：${r.probed} 个账号，可领 ${r.skipped} 个活动`,
        r.failed > 0 || r.emptyList > 0 ? 'warn' : 'ok',
      );
      onChanged();
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '执行失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    setBusy('__settings__');
    try {
      await qoderSaveSettings(form, key);
      toast('定时任务设置已保存', 'ok');
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => runBatch(true)} disabled={busy !== null}>
          {busy === '__batch__' ? '执行中…' : '跑一轮（探测 + 领取）'}
        </Button>
        <Button onClick={() => runBatch(false)} disabled={busy !== null}>
          只探测
        </Button>
        <Button onClick={load} disabled={loading}>
          刷新账号
        </Button>
        {jobs && (
          <span className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            定时任务{jobs.enabled ? '已启用' : '已停用'} · 下次执行 {formatTime(jobs.nextRunAt)}（{jobs.accounts} 个启用账号）
          </span>
        )}
      </div>

      {batch && (
        <div
          className="rounded-lg border p-3 text-[12px] flex flex-col gap-1"
          style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
        >
          <div className="font-medium">最近一轮结果</div>
          <div>
            探测 {batch.probed} · 领取 {batch.claimed} · 已领过 {batch.already} · 列表级已领 {batch.alreadyToday} · 失败{' '}
            {batch.failed} · 跳过 {batch.skipped}
            {batch.emptyList > 0 && <strong style={{ color: 'var(--rg-state-warning)' }}> · 空列表 {batch.emptyList}</strong>}
          </div>
          {batch.emptyList > 0 && (
            <div style={{ color: 'var(--rg-state-warning)' }}>
              有 {batch.emptyList} 个账号拿到空活动列表。上游在身份头被过滤时不会报错，只回空列表——
              这不等于「今天没有活动」。
            </div>
          )}
          {batch.claimedDetails?.map((c, i) => (
            <div key={`${c.accountId}:${i}`} style={{ color: 'var(--rg-state-success)' }}>
              {c.label}（{c.realm}）领取 +{c.amount} credits
              {c.expiresAt ? `，${formatTime(c.expiresAt)} 到期` : ''}
            </div>
          ))}
          {batch.failedDetails?.map((f, i) => (
            <div key={`${f.accountId}:${i}`} style={{ color: 'var(--rg-state-error)' }}>
              {f.label}：{f.message}
            </div>
          ))}
        </div>
      )}

      <div
        className="rounded-lg border p-3 flex flex-col gap-2.5"
        style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
      >
        <div className="text-[12px] font-medium">每日积分活动领取（本地时区）</div>
        <div className="flex items-center gap-4 flex-wrap text-[12px]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            启用定时领取
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.autoClaim}
              onChange={(e) => setForm((f) => ({ ...f, autoClaim: e.target.checked }))}
            />
            自动领取（关闭则只探测并通知）
          </label>
          <span className="inline-flex items-center gap-1">
            每日
            <NumInput max={23} label="领取小时" value={form.hour} onChange={(n) => setForm((f) => ({ ...f, hour: n }))} />:
            <NumInput max={59} label="领取分钟" value={form.minute} onChange={(n) => setForm((f) => ({ ...f, minute: n }))} />
          </span>
          <Button size="sm" onClick={saveSettings} disabled={busy !== null}>
            {busy === '__settings__' ? '保存中…' : '保存设置'}
          </Button>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          上游按 UTC+8 每日 10:00 刷新可领状态、领取后 30 天有效，故默认排在本地 10:15。
          部署机时区不是 UTC+8 时请自行把时刻调整到刷新之后。
        </div>
      </div>

      {loading && !accounts ? (
        <LoadingBlock label="正在读取 Qoder 账号" />
      ) : (accounts?.length ?? 0) === 0 ? (
        <EmptyState
          label="还没有 Qoder 账号。"
          hint="先在渠道总览里用「读取本机客户端」接入本机 Qoder 桌面端账号（国内版 / 国际版均可），再回来领取每日积分。"
        />
      ) : (
        <table className="card-table w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="th">账号</th>
              <th className="th">区域</th>
              <th className="th cell-num">额度（基础 + 赠送）</th>
              <th className="th">上次领取</th>
              <th className="th">状态</th>
              <th className="th cell-act">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts!.map((a) => {
              const r = results[a.id];
              const q = a.rewards?.quota;
              return (
                <Fragment key={a.id}>
                  <tr className="row-hover">
                    <td className="td" data-label="账号">
                      <div className="font-mono text-[12px] truncate" title={a.label}>
                        {a.label || a.id}
                      </div>
                      <div className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {a.userId || a.id}
                      </div>
                    </td>
                    <td className="td" data-label="区域">
                      <Chip tone={a.realm === 'intl' ? 'brand' : 'neutral'}>
                        {a.realm === 'intl' ? '国际版' : '国内版'}
                      </Chip>
                    </td>
                    <td className="td cell-num" data-label="额度">
                      {/* 两段隔离展示：基础 + 赠送，不并入任何积分汇总 */}
                      {q ? (
                        <span title="基础 userQuota + 赠送 addOnQuota（两段隔离，合计仅供阅读）">
                          {formatNumber(q.base?.remaining ?? 0)} + {formatNumber(q.addOn?.remaining ?? 0)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>未查询</span>
                      )}
                    </td>
                    <td className="td" data-label="上次领取">
                      {a.rewards?.lastClaimAt ? (
                        <span className="text-[12px]" title={a.rewards.lastClaimCampaign || undefined}>
                          {formatTime(a.rewards.lastClaimAt)}
                          {a.rewards.lastClaimAmount ? ` +${a.rewards.lastClaimAmount}` : ''}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td className="td" data-label="状态">
                      {a.enabled === false ? (
                        <Chip tone="warn">已停用</Chip>
                      ) : (
                        <Chip tone="ok" dot="dot-ok">
                          启用中
                        </Chip>
                      )}
                    </td>
                    <td className="td cell-act">
                      <div className="inline-flex items-center gap-1.5">
                        <Button size="sm" disabled={busy !== null} onClick={() => fetchCampaigns(a)}>
                          {busy === `${a.id}:campaigns` ? '查询中…' : '查活动'}
                        </Button>
                        <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => claim(a)}>
                          {busy === `${a.id}:claim` ? '领取中…' : '领取'}
                        </Button>
                        <Button size="sm" disabled={busy !== null} onClick={() => quota(a)}>
                          查额度
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {r && (
                    <tr>
                      <td className="td" colSpan={6} style={{ background: 'var(--rg-bg-secondary)' }}>
                        <div className="flex flex-col gap-1.5 py-1">
                          <span
                            style={{
                              color:
                                r.tone === 'ok'
                                  ? 'var(--rg-state-success)'
                                  : r.tone === 'warn'
                                    ? 'var(--rg-state-warning)'
                                    : 'var(--rg-state-error)',
                            }}
                          >
                            {r.text}
                          </span>

                          {r.campaigns && r.campaigns.campaigns.length > 0 && (
                            <table className="w-full text-[12px] border-collapse">
                              <thead>
                                <tr>
                                  <th className="th">活动</th>
                                  <th className="th cell-num">积分</th>
                                  <th className="th">有效期</th>
                                  <th className="th">状态</th>
                                  <th className="th cell-act">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.campaigns.campaigns.map((c) => {
                                  const st = statusOf(c);
                                  const canClaim = c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE';
                                  return (
                                    <tr key={c.campaignId}>
                                      <td className="td" data-label="活动" title={c.description || undefined}>
                                        {c.title || c.campaignKey || c.campaignId}
                                      </td>
                                      <td className="td cell-num" data-label="积分">
                                        {c.kind.toUpperCase() === 'CREDITS' && c.amount ? `+${c.amount}` : '—'}
                                      </td>
                                      <td className="td" data-label="有效期">
                                        {c.validityMode === 'RELATIVE_DAYS'
                                          ? `领取后 ${c.validityDays} 天`
                                          : c.endAt
                                            ? formatTime(c.endAt)
                                            : '—'}
                                      </td>
                                      <td className="td" data-label="状态">
                                        <Chip tone={st.tone === 'ok' ? 'ok' : st.tone === 'warn' ? 'warn' : 'neutral'}>
                                          {st.text}
                                        </Chip>
                                      </td>
                                      <td className="td cell-act">
                                        <Button
                                          size="sm"
                                          disabled={!canClaim || busy !== null}
                                          onClick={() => claim(a, c.campaignId)}
                                        >
                                          领取
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}

                          {r.quota && (
                            <table className="w-full text-[12px] border-collapse">
                              <thead>
                                <tr>
                                  <th className="th">额度段</th>
                                  <th className="th cell-num">剩余</th>
                                  <th className="th cell-num">总量</th>
                                  <th className="th">到期</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td className="td" data-label="额度段">基础（userQuota）</td>
                                  <td className="td cell-num" data-label="剩余">
                                    {formatNumber(Number(r.quota.base?.remaining) || 0)}
                                  </td>
                                  <td className="td cell-num" data-label="总量">
                                    {formatNumber(Number(r.quota.base?.total) || 0)}
                                  </td>
                                  <td className="td" data-label="到期">
                                    {r.quota.expiresAt ? formatTime(r.quota.expiresAt) : '—'}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="td" data-label="额度段">赠送（addOnQuota）</td>
                                  <td className="td cell-num" data-label="剩余">
                                    {formatNumber(Number(r.quota.addOn?.remaining) || 0)}
                                  </td>
                                  <td className="td cell-num" data-label="总量">
                                    {formatNumber(Number(r.quota.addOn?.total) || 0)}
                                  </td>
                                  <td className="td" data-label="到期">—</td>
                                </tr>
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <Note>
        积分活动由上游按 <strong>UTC+8 每日 10:00</strong> 刷新，领取后 30 天有效；
        已领取的活动再领会被上游按「重放」处理，不会重复到账。
        <br />
        「基础 + 赠送」是两段隔离的额度口径，本页合计仅供阅读，<strong>不并入</strong>面板的积分汇总。
        另外：Qoder <strong>仅国际版可参与对话转发</strong>，国内版只能领积分（上游 /model/v1 实测 503，
        需 COSY 老协议，本期未实现）。
      </Note>
    </div>
  );
}
