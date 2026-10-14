/**
 * 凭据池页：账号凭据的启用、签到、余额与设备重置。
 * 所有操作均对应 /v1/credentials 真实接口，无虚构能力。
 */
import { useCallback, useMemo, useState } from 'react';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import {
  checkinAll,
  checkinOne,
  deleteAccount,
  listAccounts,
  patchAccount,
  refreshOneBalance,
  resetAllDevices,
} from '../../shared/api/credentials';
import { wbCheckin as wbCheckinOne } from '../../shared/api/workbuddy';
import { ApiError } from '../../shared/api/http';
import { runAction, summarizeBatch } from '../../shared/api/action';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { useBalanceAutoRefresh } from '../../shared/hooks/useBalanceAutoRefresh';
import {
  accountState,
  coolRemaining,
  formatDate,
  formatNumber,
  formatTime,
  platformLabel,
  platformOf,
  STATE_DOT_CLASS,
  STATE_LABEL,
} from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';
import { ImportTraeDialog } from './ImportTraeDialog';
import { ImportWbDialog } from './ImportWbDialog';
import { ImportQoderDialog } from './ImportQoderDialog';
import { OauthTraeDialog } from './OauthTraeDialog';
import { GrowthPanel } from './GrowthPanel';
import { ExpiryChip, expirySummary, keepaliveOf, usablePacksOf, worstExpiry } from './accountPacks';
import { PackDialog } from './PackDialog';

type StateFilter = 'all' | 'ok' | 'cool' | 'off';
type SourceFilter = 'all' | 'trae' | 'workbuddy' | 'zcode' | 'qoder';

export default function CredentialsPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();

  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showOauth, setShowOauth] = useState(false);
  const [showWbImport, setShowWbImport] = useState(false);
  const [showQoderImport, setShowQoderImport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);
  /** 查看权益包的账号；null 表示弹窗关闭 */
  const [packTarget, setPackTarget] = useState<Account | null>(null);
  /** 需要重新登录的账号；null 表示 OAuth 弹窗关闭 */
  const [reloginTarget, setReloginTarget] = useState<Account | null>(null);

  const list = useAsyncData(
    (signal) => listAccounts(key, signal),
    [key],
    { enabled: !!key },
  );

  // 页面可见时每 60 秒触发一次真实余额查询；
  // 重新拉取后同时重读列表与全局汇总，保持侧栏可用数与列表一致。
  const { reload: reloadList } = list;
  const { reload: reloadSummary } = useSummaryStore();
  const reloadAfterBalance = useCallback(() => {
    reloadList();
    reloadSummary();
  }, [reloadList, reloadSummary]);
  useBalanceAutoRefresh(key, reloadAfterBalance);

  // 过滤与排序均为派生值，不写入 state
  const rows = useMemo(() => {
    const all = list.data ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((a) => {
      const st = accountState(a);
      if (stateFilter !== 'all' && st !== stateFilter) return false;
      if (sourceFilter !== 'all') {
        // 来源筛选按平台等值匹配。此前只特判 workbuddy（其余值一律显示
        // 非 WorkBuddy 账号），导致选「ZCode」「Trae」时列表内容与「全部」相同；
        // 现在四个来源都是等值比较。
        const platform = platformOf(a);
        if (platform !== sourceFilter) return false;
      }
      if (q) {
        const hay = `${a.label ?? ''} ${a.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [list.data, query, stateFilter, sourceFilter]);

  // 到期汇总只用于工具条提示，明细在行内展开，不占页面主体空间
  const expiry = useMemo(() => expirySummary(rows), [rows]);

  /** 统一包装写操作：错误必须展示到 UI，不能只写入 console。（实现见 shared/api/action） */
  async function run(
    id: string,
    label: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) {
    setBusyId(id);
    try {
      return await runAction({
        label,
        fn,
        successMsg,
        toast,
        onDone: list.reload,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(a: Account) {
    await run(a.id, a.enabled ? '停用' : '启用', () => patchAccount(a.id, { enabled: !a.enabled }, key), a.enabled ? '已停用' : '已启用');
  }

  async function checkin(a: Account) {
    // 按平台分发：WorkBuddy 走它自己的签到端点（/v1/workbuddy/checkin），Trae 系走通用端点。
    // 此前统一打到 /v1/credentials/:id/checkin，后端平台闸门对 WorkBuddy 直接抛
    // 「not a trae account」，按钮因此不可用（m-39）。
    if (platformOf(a) === 'workbuddy') {
      await run(a.id, '签到', () => wbCheckinOne({ accountId: a.id }, key), '签到完成');
    } else {
      await run(a.id, '签到', () => checkinOne(a.id, key), '签到完成');
    }
  }

  async function checkinEveryOne() {
    setBusyId('__all__');
    try {
      // 跨平台聚合签到：同时覆盖 Trae + WorkBuddy（旧接口只签 Trae），
      // toast 如实展示分平台明细（m-39）。
      const r = await checkinAll(key);
      const claimed = r.claimed ?? 0;
      const already = r.already ?? 0;
      const failed = r.failed ?? 0;
      if (failed > 0) {
        // 分平台结果含逐账号原因，取前几条展示，不能只报计数
        const reasons = (r.platforms ?? [])
          .flatMap((p) => p.accounts.filter((x) => !x.result || /fail|error|未/i.test(x.result)))
          .slice(0, 3)
          .map((x) => [x.label, x.reason].filter(Boolean).join('：'))
          .filter(Boolean)
          .join('；');
        toast(
          `签到完成（${claimed} 新签 / ${already} 已签 / ${failed} 失败）：${r.message ?? ''}${
            reasons ? `；${reasons}` : ''
          }`,
          'err',
        );
      } else if (claimed > 0) {
        toast(`签到完成：${claimed} 个新签，${already} 个今日已签`, 'ok');
      } else {
        toast(`今日均已签到（${already} 个账号）`, 'ok');
      }
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '批量签到请求失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function checkBalance(a: Account) {
    await run(a.id, '查余额', () => refreshOneBalance(a.id, key), '余额已更新');
  }

  async function remove(a: Account) {
    const ok = await prompt({
      title: `删除凭据 ${a.label || a.id}？`,
      message: '删除后该凭据不再参与调度，此操作不可撤销。',
      okText: '删除',
      danger: true,
    });
    if (ok !== true) return;
    await run(a.id, '删除', () => deleteAccount(a.id, key), '已删除');
  }

  /**
   * 行内「重新登录」：refreshToken 已过期的账号无法自动续期，
   * 按平台分发到各自的重新获取凭据入口（Trae 走 OAuth，WorkBuddy 走本机抓取）。
   */
  function relogin(a: Account) {
    const platform = platformOf(a);
    if (platform === 'workbuddy') {
      setShowWbImport(true);
      toast(`WorkBuddy 账号需在「接入 WorkBuddy」里重新抓取本机登录态：${a.label || a.id}`, 'warn');
      return;
    }
    setReloginTarget(a);
    setShowOauth(true);
  }

  async function resetDevices() {
    const ok = await prompt({
      title: '重置已启用账号的设备标识？',
      message: '将对所有「已启用」的凭据重置设备标识（停用账号不受影响），不改动凭据本身与路由配置。',
      okText: '重置',
      danger: true,
    });
    if (ok !== true) return;
    setBusyId('__dev__');
    try {
      summarizeBatch('设备标识重置', await resetAllDevices(key), toast);
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '重置失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageShell
      title="凭据池"
      description="接入、启用与排查上游账号凭据"
      actions={
        <>
          <Chip tone="brand" dot="dot-ok">
            每 60 秒自动刷新
          </Chip>
          <Button onClick={checkinEveryOne} disabled={busyId === '__all__'}>
            {busyId === '__all__' ? '执行中…' : '全部签到'}
          </Button>
          <Button variant="primary" onClick={list.reload}>
            刷新
          </Button>
        </>
      }
      toolbar={
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-[240px]">
              <Field
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按账号标签或 ID 筛选"
                aria-label="按账号标签或 ID 筛选"
              />
            </div>
            <Segmented
              ariaLabel="来源筛选"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'trae', label: 'Trae' },
                { value: 'workbuddy', label: 'WorkBuddy' },
                { value: 'zcode', label: 'ZCode' },
                { value: 'qoder', label: 'Qoder' },
              ]}
            />
            <Segmented
              ariaLabel="状态筛选"
              value={stateFilter}
              onChange={setStateFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'ok', label: '可用' },
                { value: 'cool', label: '冷却中' },
                { value: 'off', label: '停用' },
              ]}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => setGrowthOpen((v) => !v)}>
              {growthOpen ? '收起成长中心' : '成长中心'}
            </Button>
            {/* 这两个 Chip 是「账号数」口径；总览页的「3日内到期积分」是「额度」
                口径（后端 summary.expiring3d）。文案已写明「个账号」以示区分。 */}
            {expiry.expired > 0 ? (
              <Chip tone="danger" dot="dot-error">
                {expiry.expired} 个账号额度已到期
              </Chip>
            ) : expiry.expiring > 0 ? (
              <Chip tone="warn" dot="dot-cool">
                {expiry.expiring} 个账号额度 7 日内到期
              </Chip>
            ) : null}
            <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              共 {rows.length} 个账号
            </span>
          </div>
        </>
      }
    >
      <Stack>
        {list.error && <ErrorState message={list.error} onRetry={list.reload} />}

        <Panel title="接入新账号">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="primary" onClick={() => setShowOauth(true)}>
              Trae OAuth 登录
            </Button>
            <Button onClick={() => setShowWbImport(true)}>接入 WorkBuddy</Button>
            <Button onClick={() => setShowQoderImport(true)}>接入 Qoder</Button>
            <Button
              onClick={() => setShowImport(true)}
              aria-label="导入凭据 JSON"
            >
              粘贴凭据导入
            </Button>
          </div>
        </Panel>

        <Panel
          title="凭据列表"
          actions={
            <Button size="sm" onClick={resetDevices} disabled={busyId === '__dev__'}>
              重置已启用账号的设备标识
            </Button>
          }
          flush
        >
          {list.loading && !list.data ? (
            <LoadingBlock />
          ) : (list.data?.length ?? 0) === 0 ? (
            <EmptyState
              label="还没有接入任何账号。"
              hint="接入上游账号后才能转发请求；总览页也会开始显示待处理事项。"
              action={{ label: '接入第一个账号', onClick: () => setShowOauth(true) }}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              label="当前筛选条件下没有匹配账号。"
              hint={`库中共有 ${list.data?.length ?? 0} 个账号。`}
              action={{
                label: '清除筛选',
                onClick: () => {
                  setQuery('');
                  setStateFilter('all');
                  setSourceFilter('all');
                },
              }}
            />
          ) : (
            <table className="card-table table-fixed w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th col-toggle">启用</th>
                  <th className="th col-account">账号</th>
                  <th className="th col-state">状态</th>
                  <th className="th col-source">平台</th>
                  <th className="th col-pack">权益包</th>
                  <th className="th col-expiry">权益到期</th>
                  <th className="th col-token">账号到期</th>
                  <th className="th col-balance cell-num">余额 / 额度</th>
                  <th className="th col-cool">冷却至</th>
                  <th className="th col-actions cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = accountState(a);
                  const cooling = coolRemaining(a.coolUntil);
                  const rowPacks = usablePacksOf(a);
                  const busy = busyId === a.id;
                  const expiryWorst = worstExpiry(a);
                  const keepalive = keepaliveOf(a);
                  const keepaliveNeedsRelogin = keepalive.label === '需重新登录';
                  const platform = platformLabel(a);
                  return (
                    <tr key={a.id} className="row-hover">
                        <td className="td" data-label="启用">
                          <Button
                            size="sm"
                            variant={a.enabled ? 'primary' : 'default'}
                            disabled={busy}
                            onClick={() => toggleEnabled(a)}
                            aria-label={a.enabled ? '停用该账号' : '启用该账号'}
                          >
                            {a.enabled ? '停用' : '启用'}
                          </Button>
                        </td>
                        <td className="td" data-label="账号">
                          <div className="font-mono text-[12px] truncate" title={a.label || a.id}>
                            {a.label || a.id}
                          </div>
                          <div
                            className="font-mono text-[11px] truncate"
                            style={{ color: 'var(--rg-text-tertiary)' }}
                            title={a.id}
                          >
                            {a.id}
                          </div>
                        </td>
                        <td className="td" data-label="状态">
                          <Chip tone="neutral" dot={STATE_DOT_CLASS[st]}>
                            {STATE_LABEL[st]}
                          </Chip>
                        </td>
                        {/* 平台而非 source：source 是「凭据怎么进来的」（import/oauth/local），
                            Trae 账号一律是 import，显示成 import 会被误读为平台 */}
                        <td className="td whitespace-nowrap" data-label="平台">{platform}</td>
                        {/* 「权益包」只回答「这个账号有几个还能用的包」；
                            额度总量在右侧「余额 / 额度」（= 可用包 remaining 之和），
                            到期紧迫度在「权益到期」列。三列不重复。
                            与 PackDialog 同源（usablePacksOf），无包时显示 —。 */}
                        <td className="td whitespace-nowrap" data-label="权益包">
                          {rowPacks.length > 0 ? (
                            <button
                              type="button"
                              className="inline-flex items-center"
                              onClick={() => setPackTarget(a)}
                              aria-haspopup="dialog"
                              aria-label={`查看 ${a.label || a.id} 的权益包明细`}
                              title={`${rowPacks.length} 个可用权益包，明细见弹窗`}
                            >
                              {rowPacks.length} 个可用
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td" data-label="权益到期">
                          <button
                            type="button"
                            className="inline-flex items-center"
                            onClick={() => setPackTarget(a)}
                            aria-haspopup="dialog"
                            aria-label={`查看 ${a.label || a.id} 的权益包`}
                          >
                            <ExpiryChip item={expiryWorst} />
                          </button>
                        </td>
                        {/* 账号到期 = 登录 token 的有效期，与左侧「权益到期」是两套口径。
                            hover 提示带上 refreshToken 到期时间（它过期后无法再换新） */}
                        <td className="td" data-label="账号到期">
                          <span
                            className="font-mono text-[12px]"
                            title={
                              keepalive.expiresMs == null
                                ? keepalive.label
                                : `登录 Token 到期：${formatTime(a.expiredAt)}${
                                    keepalive.refreshExpiresMs == null
                                      ? ''
                                      : `；refreshToken 到期：${formatTime(a.refreshExpiredAt)}`
                                  }`
                            }
                          >
                            {keepalive.expiresMs == null ? (
                              <span style={{ color: 'var(--rg-text-tertiary)' }}>{keepalive.label}</span>
                            ) : (
                              <>
                                {formatDate(a.expiredAt)}
                                <span
                                  className="ml-1.5 text-[11px]"
                                  style={{
                                    color:
                                      keepalive.tone === 'warn'
                                        ? 'var(--rg-state-warning)'
                                        : keepalive.tone === 'danger'
                                          ? 'var(--rg-state-error)'
                                          : 'var(--rg-text-tertiary)',
                                  }}
                                >
                                  {keepalive.label}
                                </span>
                              </>
                            )}
                          </span>
                        </td>
                        <td className="td cell-num" data-label="余额 / 额度">
                          {typeof a.tokenRemaining === 'number' ? (
                            // ZCode：token 计量，与积分列分开标注单位（不并入积分口径）
                            <span title="ZCode Token 计量额度，不计入积分">
                              {formatNumber(a.tokenRemaining)} <span className="text-[11px]">tok</span>
                            </span>
                          ) : a.quota ? (
                            // Qoder：两段额度隔离展示（基础 userQuota + 赠送 addOnQuota），
                            // 与 ZCode 同理不并入积分口径；合计仅供展示，不得累加进面板汇总
                            <span title={`${a.quota.userType || ''} · 基础 ${a.quota.base?.remaining ?? '—'} + 赠送 ${a.quota.addOn?.remaining ?? '—'}（两段隔离，不计入积分汇总）`}>
                              {formatNumber(a.quota.totalRemaining)} <span className="text-[11px]">cr</span>
                            </span>
                          ) : (
                            // 后端口径：该账号全部可用权益包 remaining 之和（src/upstream/balance.js）
                            <span title="该账号全部可用权益包的剩余积分之和">
                              {formatNumber(a.balance)}
                            </span>
                          )}
                        </td>
                        <td className="td font-mono text-[12px]" data-label="冷却至">
                          {st === 'cool' && cooling ? (
                            <span style={{ color: 'var(--rg-state-warning)' }}>{cooling}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td cell-act">
                          <div className="inline-flex items-center gap-1.5">
                            {/* 「需重新登录」是 refreshToken 过期，账号无法自愈。
                                此前这一行只有签到/查余额/删除，修复入口在表格上方另一个 Panel；
                                现补上行内入口，直接打开该平台的重新登录流程。 */}
                            {keepaliveNeedsRelogin && (
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => relogin(a)}
                              >
                                重新登录
                              </Button>
                            )}
                            {/* 签到按钮按平台能力显示：ZCode 与 Qoder 均无签到能力（后端也会拒绝），
                                故隐藏，其奖励分别走 /v1/zcode 与 /v1/qoder 的定时任务；
                                Trae 与 WorkBuddy 均有签到能力，仅端点不同，
                                checkin() 内部按 platformOf 分发（m-39）。 */}
                            {platformOf(a) !== 'zcode' && platformOf(a) !== 'qoder' && (
                              <Button size="sm" disabled={busy} onClick={() => checkin(a)}>
                                签到
                              </Button>
                            )}
                            <Button size="sm" disabled={busy} onClick={() => checkBalance(a)}>
                              查余额
                            </Button>
                            <Button size="sm" variant="danger" disabled={busy} onClick={() => remove(a)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="最近操作与保活"
          description="用于判断凭据是否仍在被调度与保活"
          flush
        >
          <table className="card-table table-fixed w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th col-account">账号</th>
                <th className="th">最近选用</th>
                <th className="th">最近签到</th>
                <th className="th">签到结果</th>
                <th className="th">最近保活</th>
                <th className="th">保活结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((a) => (
                <tr key={a.id} className="row-hover">
                  <td className="td font-mono text-[12px]" data-label="账号">{a.label || a.id}</td>
                  <td className="td font-mono text-[12px]" data-label="最近选用">{formatTime(a.lastPickedAt)}</td>
                  <td className="td font-mono text-[12px]" data-label="最近签到">{formatTime(a.lastCheckinAt)}</td>
                  <td className="td font-mono text-[12px]" data-label="签到结果">{a.lastCheckinResult || '—'}</td>
                  <td className="td font-mono text-[12px]" data-label="最近保活">{formatTime(a.lastKeepaliveAt)}</td>
                  <td className="td font-mono text-[12px] truncate" title={a.lastKeepaliveResult || undefined} data-label="保活结果">
                    {a.lastKeepaliveResult || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {growthOpen && <GrowthPanel />}
      </Stack>

      <OauthTraeDialog
        open={showOauth}
        presetLabel={reloginTarget?.label ?? reloginTarget?.id ?? undefined}
        onClose={() => {
          setShowOauth(false);
          setReloginTarget(null);
        }}
        onDone={list.reload}
      />
      <ImportWbDialog
        open={showWbImport}
        onClose={() => setShowWbImport(false)}
        onImported={list.reload}
      />
      <ImportQoderDialog
        open={showQoderImport}
        onClose={() => setShowQoderImport(false)}
        onImported={list.reload}
      />
      <ImportTraeDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={list.reload}
      />
      <PackDialog account={packTarget} onClose={() => setPackTarget(null)} />
    </PageShell>
  );
}
