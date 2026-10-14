/**
 * ZCode 运营面：限时套餐探测与领取 + token 额度 + 设备指纹。
 *
 * 为什么需要它：后端的 `/v1/zcode/rewards/*`、`/accounts/:id/balance`、
 * `/accounts/:id/fingerprint/rotate` 一直只有 API，没有任何界面入口——
 * 参考项目在这一点上是「渠道页面一键领取」，而本项目的用户只能去翻文档打 curl。
 *
 * 三条必须遵守的口径（违反会静默出错，见 docs/zcode-integration.md）：
 *   1. **额度单位是 token**（单包量级 1e8），与积分（credit，量级 1e3）是两套计量，
 *      这里只做展示，绝不并入任何积分汇总；
 *   2. 领取要现解阿里云无感验证码（单次 2–8 秒），故这些请求用 180 秒超时
 *      （在 shared/api/zcode.ts 统一设置），不能沿用默认 30 秒；
 *   3. `3012` 是真风控，后端会立即中止该账号且**不会**自动换指纹——
 *      换指纹是这里的人工按钮，界面上必须说明它是人工决策。
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import type { ChannelJobs } from '../../shared/api/channels';
import {
  zcodeAccounts,
  zcodeClaim,
  zcodeDiagnoseCaptcha,
  zcodeProbe,
  zcodeRefreshBalance,
  zcodeRotateFingerprint,
  zcodeRunRewards,
  zcodeSaveSettings,
  type ZcodeAccount,
  type ZcodeBalanceResult,
  type ZcodePlan,
  type ZcodeRunSummary,
} from '../../shared/api/zcode';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Button, Chip, EmptyState, LoadingBlock, Note } from '../../shared/ui';
import { useToast } from '../../shared/ui/Toast';

/** 每账号最近一次操作结果（探测到的套餐 / 额度 / 文案）。 */
interface RowResult {
  tone: 'ok' | 'warn' | 'err';
  text: string;
  plans?: ZcodePlan[];
  balance?: ZcodeBalanceResult;
}

/** 定时任务表单（本地态，保存后由父级重取快照）。 */
interface JobsForm {
  enabled: boolean;
  autoClaim: boolean;
  hour1: number;
  minute1: number;
  hour2: number;
  minute2: number;
}

function formFrom(jobs: ChannelJobs | null): JobsForm {
  return {
    enabled: jobs?.enabled ?? false,
    autoClaim: jobs?.autoClaim ?? true,
    hour1: jobs?.hour1 ?? 0,
    minute1: jobs?.minute1 ?? 30,
    hour2: jobs?.hour2 ?? 21,
    minute2: jobs?.minute2 ?? 30,
  };
}

/** 紧凑数字输入：Field 会强制 w-full，在工具条里会撑开，这里直接用 field 类定宽。 */
function HourInput({ value, label, onChange }: { value: number; label: string; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      max={23}
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

function MinuteInput({ value, label, onChange }: { value: number; label: string; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      max={59}
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

export function ZcodeOps({ jobs, onChanged }: { jobs: ChannelJobs | null; onChanged: () => void }) {
  const { key } = useAuth();
  const toast = useToast();
  const [accounts, setAccounts] = useState<ZcodeAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [form, setForm] = useState<JobsForm>(() => formFrom(jobs));
  const [batch, setBatch] = useState<ZcodeRunSummary | null>(null);

  // 父级重新拉到快照后同步表单（用户正在编辑时会被覆盖，故只在快照身份变化时同步）
  useEffect(() => {
    setForm(formFrom(jobs));
  }, [jobs]);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const r = await zcodeAccounts(key);
      setAccounts(r.data ?? []);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取 ZCode 账号失败', 'err');
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

  async function probe(a: ZcodeAccount) {
    await runOn(a.id, 'probe', async () => {
      const r = await zcodeProbe(a.id, key);
      // 「探测本身失败」与「确实没有可领套餐」是两件事，不能都显示成没有
      if (r.error) return { tone: 'err', text: `探测失败：${r.error}` };
      if (!r.plans.length) return { tone: 'warn', text: '当前没有可领取的套餐', plans: [] };
      return { tone: 'ok', text: `发现 ${r.plans.length} 个可领套餐`, plans: r.plans };
    });
  }

  async function claim(a: ZcodeAccount, planId?: string) {
    await runOn(a.id, 'claim', async () => {
      const r = await zcodeClaim(a.id, key, planId);
      const tone = r.result === 'claimed' ? 'ok' : r.result === 'already' ? 'warn' : 'err';
      onChanged();
      void load();
      return { tone, text: r.message || `${r.planName || r.planId}：${r.result}` };
    });
  }

  async function balance(a: ZcodeAccount) {
    await runOn(a.id, 'balance', async () => {
      const r = await zcodeRefreshBalance(a.id, key);
      const total = (r.balances || []).reduce((s, b) => s + (Number(b.remaining_units) || 0), 0);
      onChanged();
      void load();
      return { tone: 'ok', text: `剩余 ${formatNumber(total)} tokens`, balance: r };
    });
  }

  async function rotate(a: ZcodeAccount) {
    await runOn(a.id, 'rotate', async () => {
      const r = await zcodeRotateFingerprint(a.id, key);
      onChanged();
      return { tone: r.ok ? 'ok' : 'warn', text: r.ok ? '设备指纹已换发（device_mid 已变）' : '换发未成功' };
    });
  }

  async function runBatch(claimIt: boolean) {
    setBusy('__batch__');
    try {
      const r = await zcodeRunRewards(key, claimIt);
      setBatch(r);
      toast(
        claimIt
          ? `一轮完成：探测 ${r.probed}，有新套餐 ${r.withPlans}，领取 ${r.claimed}，已领过 ${r.already}，失败 ${r.failed}${r.risk ? `，风控 ${r.risk}` : ''}`
          : `探测完成：${r.probed} 个账号，${r.withPlans} 个有可领套餐`,
        r.failed > 0 || r.risk > 0 ? 'warn' : 'ok',
      );
      onChanged();
      void load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '执行失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function diagnose() {
    setBusy('__captcha__');
    try {
      const r = await zcodeDiagnoseCaptcha(key);
      toast(
        r.ok ? `验证码求解可用（区域 ${r.region ?? '?'}）` : `验证码不可用：${r.error?.message ?? ''}`,
        r.ok ? 'ok' : 'err',
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '自检失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings() {
    setBusy('__settings__');
    try {
      await zcodeSaveSettings(form, key);
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
        <Button onClick={diagnose} disabled={busy !== null}>
          {busy === '__captcha__' ? '求解中…' : '验证码自检'}
        </Button>
        <Button onClick={load} disabled={loading}>
          刷新账号
        </Button>
        {jobs && (
          <span className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            定时任务{jobs.enabled ? '已启用' : '已停用'} · 下次执行 {formatTime(jobs.nextRunAt)} · 求解器
            {jobs.solver?.available ? '可用' : '不可用'}（{jobs.accounts} 个启用账号）
          </span>
        )}
      </div>

      {/* 一轮批量结果：失败明细必须给出，只报计数等于没有反馈 */}
      {batch && (batch.failed > 0 || batch.claimed > 0 || (batch.claimedPlans?.length ?? 0) > 0) && (
        <div
          className="rounded-lg border p-3 text-[12px] flex flex-col gap-1"
          style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
        >
          <div className="font-medium">最近一轮结果</div>
          <div>
            探测 {batch.probed} · 有新套餐 {batch.withPlans} · 领取 {batch.claimed} · 已领过 {batch.already} · 失败{' '}
            {batch.failed} · 跳过 {batch.skipped}
            {batch.risk > 0 && (
              <strong style={{ color: 'var(--rg-state-error)' }}> · 风控 {batch.risk}</strong>
            )}
          </div>
          {batch.claimedPlans?.map((p) => (
            <div key={`${p.accountId}:${p.planId}`} style={{ color: 'var(--rg-state-success)' }}>
              {p.label} 领取 {p.planName}：{p.grants.join('、')}
            </div>
          ))}
          {batch.failedDetails?.map((f, i) => (
            <div key={`${f.accountId}:${i}`} style={{ color: f.risk ? 'var(--rg-state-error)' : 'var(--rg-text-secondary)' }}>
              {f.label}：{f.message}
              {f.risk ? '（风控，已中止该账号，不会自动换指纹）' : ''}
            </div>
          ))}
        </div>
      )}

      {/* 定时任务设置 */}
      <div
        className="rounded-lg border p-3 flex flex-col gap-2.5"
        style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
      >
        <div className="text-[12px] font-medium">每日定时探测与领取（本地时区）</div>
        <div className="flex items-center gap-4 flex-wrap text-[12px]">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            启用定时探测
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
            时段一
            <HourInput label="时段一 小时" value={form.hour1} onChange={(n) => setForm((f) => ({ ...f, hour1: n }))} />:
            <MinuteInput label="时段一 分钟" value={form.minute1} onChange={(n) => setForm((f) => ({ ...f, minute1: n }))} />
          </span>
          <span className="inline-flex items-center gap-1">
            时段二
            <HourInput label="时段二 小时" value={form.hour2} onChange={(n) => setForm((f) => ({ ...f, hour2: n }))} />:
            <MinuteInput label="时段二 分钟" value={form.minute2} onChange={(n) => setForm((f) => ({ ...f, minute2: n }))} />
          </span>
          <Button size="sm" onClick={saveSettings} disabled={busy !== null}>
            {busy === '__settings__' ? '保存中…' : '保存设置'}
          </Button>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          默认 00:30 与 21:30：00:30 抓上游日切后的新批次，21:30 补晚间二次投放。保存后立即重排定时器。
        </div>
      </div>

      {loading && !accounts ? (
        <LoadingBlock label="正在读取 ZCode 账号" />
      ) : (accounts?.length ?? 0) === 0 ? (
        <EmptyState
          label="还没有 ZCode 账号。"
          hint="先在渠道总览里用「读取本机客户端」接入本机 ZCode 桌面端账号，再回来领取限时套餐。"
        />
      ) : (
        <table className="card-table w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="th">账号</th>
              <th className="th cell-num">剩余额度</th>
              <th className="th">上次领取</th>
              <th className="th">状态</th>
              <th className="th cell-act">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts!.map((a) => {
              const r = results[a.id];
              const last = a.rewards?.lastClaimPlan;
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
                    <td className="td cell-num" data-label="剩余额度">
                      {/* token 计量：单独标注单位，绝不并入积分列 */}
                      {typeof a.tokenRemaining === 'number' ? (
                        <span title="ZCode Token 计量额度，不计入积分">
                          {formatNumber(a.tokenRemaining)} <span className="text-[11px]">tok</span>
                        </span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>未查询</span>
                      )}
                    </td>
                    <td className="td" data-label="上次领取">
                      {a.rewards?.lastClaimAt ? (
                        <span className="text-[12px]" title={last?.message || undefined}>
                          {formatTime(a.rewards.lastClaimAt)}
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
                        <Button size="sm" disabled={busy !== null} onClick={() => probe(a)}>
                          {busy === `${a.id}:probe` ? '探测中…' : '探测'}
                        </Button>
                        <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => claim(a)}>
                          {busy === `${a.id}:claim` ? '领取中…' : '领取'}
                        </Button>
                        <Button size="sm" disabled={busy !== null} onClick={() => balance(a)}>
                          查额度
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => rotate(a)}
                          title="风控后人工换设备；定时任务不会自动换"
                        >
                          换设备
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {r && (
                    <tr>
                      <td className="td" colSpan={5} style={{ background: 'var(--rg-bg-secondary)' }}>
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

                          {r.plans && r.plans.length > 0 && (
                            <table className="w-full text-[12px] border-collapse">
                              <thead>
                                <tr>
                                  <th className="th">套餐</th>
                                  <th className="th">赠送额度</th>
                                  <th className="th">周期</th>
                                  <th className="th cell-act">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.plans.map((p) => (
                                  <tr key={p.planId}>
                                    <td className="td" data-label="套餐">
                                      {p.name || p.planId}
                                    </td>
                                    <td className="td" data-label="赠送额度">
                                      {p.grants.length === 0
                                        ? '—'
                                        : p.grants.map((g) => (
                                            <div key={g.name}>
                                              {g.name}：{formatNumber(g.units)} tokens
                                            </div>
                                          ))}
                                    </td>
                                    <td className="td" data-label="周期">
                                      {p.grants[0]?.period === 'daily' ? '每日' : '一次性'}
                                    </td>
                                    <td className="td cell-act">
                                      <Button size="sm" disabled={busy !== null} onClick={() => claim(a, p.planId)}>
                                        领取此套餐
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}

                          {r.balance && (
                            <table className="w-full text-[12px] border-collapse">
                              <thead>
                                <tr>
                                  <th className="th">额度桶</th>
                                  <th className="th cell-num">剩余</th>
                                  <th className="th cell-num">已用</th>
                                  <th className="th">到期</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.balance.balances.length === 0 ? (
                                  <tr>
                                    <td className="td" colSpan={4}>
                                      上游未返回任何额度桶
                                    </td>
                                  </tr>
                                ) : (
                                  r.balance.balances.map((b, i) => (
                                    <tr key={b.bucket_id || b.show_name || b.entitlement_id || String(i)}>
                                      <td className="td" data-label="额度桶">
                                        {b.show_name || b.entitlement_id || '—'}
                                      </td>
                                      <td className="td cell-num" data-label="剩余">
                                        {formatNumber(Number(b.remaining_units) || 0)}
                                      </td>
                                      <td className="td cell-num" data-label="已用">
                                        {formatNumber(Number(b.used_units) || 0)}
                                      </td>
                                      <td className="td" data-label="到期">
                                        {b.expires_at ? formatTime(new Date(Number(b.expires_at)).toISOString()) : '长期'}
                                      </td>
                                    </tr>
                                  ))
                                )}
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
        <strong>3012「unusual activity」是真风控</strong>：命中时后端会立即中止该账号本轮，并且
        <strong>不会自动换指纹重试</strong>。「换设备」是人工决策按钮，换完设备标识就变了。
        <br />
        额度单位是 token（单包量级 1e8），与 RelayGate 的积分（credit，量级 1e3）是两套计量，
        本页只做展示，不并入任何积分汇总。
      </Note>
    </div>
  );
}
