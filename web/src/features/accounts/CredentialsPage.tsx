/**
 * 凭据池页：账号凭据的启用、签到、余额与设备重置。
 * 所有操作均对应 /v1/credentials 真实接口，无虚构能力。
 */
import { useMemo, useState } from 'react';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import {
  checkinAll,
  checkinOne,
  deleteAccount,
  listAccounts,
  patchAccount,
  refreshOneBalance,
  resetAllDevices,
} from '../../shared/api/credentials';
import { ApiError, isBusinessFailure } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import {
  accountState,
  coolRemaining,
  formatNumber,
  formatQuota,
  formatTime,
  STATE_DOT_CLASS,
  STATE_LABEL,
} from '../../shared/lib/format';
import {
  Button,
  Chip,
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
import { OauthTraeDialog } from './OauthTraeDialog';
import { GrowthPanel } from './GrowthPanel';
import { ExpiryChip, expirySummary, worstExpiry } from './accountPacks';
import { PackDialog } from './PackDialog';

type StateFilter = 'all' | 'ok' | 'cool' | 'off';
type SourceFilter = 'all' | 'trae' | 'workbuddy';

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
  const [showImport, setShowImport] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);
  /** 查看权益包的账号；null 表示弹窗关闭 */
  const [packTarget, setPackTarget] = useState<Account | null>(null);

  const list = useAsyncData(
    (signal) => listAccounts(key, signal),
    [key],
    { enabled: !!key },
  );

  // 过滤与排序都是派生值，不落state
  const rows = useMemo(() => {
    const all = list.data ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((a) => {
      const st = accountState(a);
      if (stateFilter !== 'all' && st !== stateFilter) return false;
      if (sourceFilter !== 'all') {
        const raw = String(a.edition || a.source || '');
        const isWb = raw === 'workbuddy' || raw.startsWith('wb');
        if (sourceFilter === 'workbuddy' ? !isWb : isWb) return false;
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

  /** 统一包装写操作：错误必须落到 UI，不能只console。 */
  async function run(
    id: string,
    label: string,
    fn: () => Promise<unknown>,
    successMsg: string,
  ) {
    setBusyId(id);
    try {
      const result = await fn();
      // 业务层失败（HTTP 成功但 ok:false）要与请求异常分开提示
      if (isBusinessFailure(result)) {
        const reason = (result as { reason?: string }).reason;
        toast(`${label}未成功：${reason ?? '后端未给出原因'}`, 'err');
        return false;
      }
      toast(successMsg, 'ok');
      list.reload();
      return true;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : `${label}失败`;
      toast(msg, 'err');
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(a: Account) {
    await run(a.id, a.enabled ? '停用' : '启用', () => patchAccount(a.id, { enabled: !a.enabled }, key), a.enabled ? '已停用' : '已启用');
  }

  async function checkin(a: Account) {
    await run(a.id, '签到', () => checkinOne(a.id, key), '签到完成');
  }

  async function checkinEveryOne() {
    setBusyId('__all__');
    try {
      await checkinAll(key);
      toast('已触发全部签到', 'ok');
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '批量签到失败', 'err');
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

  async function resetDevices() {
    const ok = await prompt({
      title: '重置全部账号的设备标识？',
      message: '将重置所有凭据的设备标识，不影响凭据本身与路由配置。',
      okText: '重置',
      danger: true,
    });
    if (ok !== true) return;
    setBusyId('__dev__');
    try {
      const r = await resetAllDevices(key);
      toast(`重置完成：成功 ${r.ok?.length ?? 0}，失败 ${r.failed?.length ?? 0}`, r.failed?.length ? 'warn' : 'ok');
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
      description="账号凭据的启用、签到、余额与设备标识管理"
      actions={
        <>
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
                placeholder="按账号标签或ID 筛选"
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
            {expiry.expired > 0 ? (
              <Chip tone="danger" dot="dot-error">
                {expiry.expired} 个账号已到期
              </Chip>
            ) : expiry.expiring > 0 ? (
              <Chip tone="warn" dot="dot-cool">
                {expiry.expiring} 个账号 7 日内到期
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
              重置全部设备标识
            </Button>
          }
          flush
        >
          {list.loading && !list.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              没有符合条件的账号
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">启用</th>
                  <th className="th">账号</th>
                  <th className="th">状态</th>
                  <th className="th">来源</th>
                  <th className="th">权益包</th>
                  <th className="th">到期</th>
                  <th className="th cell-num">余额</th>
                  <th className="th">冷却至</th>
                  <th className="th cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = accountState(a);
                  const cooling = coolRemaining(a.coolUntil);
                  const pack = a.packs?.[0];
                  const busy = busyId === a.id;
                  const expiryWorst = worstExpiry(a);
                  return (
                    <tr key={a.id} className="row-hover">
                        <td className="td">
                          <Button
                            size="sm"
                            variant={a.enabled ? 'primary' : 'default'}
                            disabled={busy}
                            onClick={() => toggleEnabled(a)}
                            aria-label={a.enabled ? '停用该账号' : '启用该账号'}
                          >
                            {a.enabled ? '开' : '关'}
                          </Button>
                        </td>
                        <td className="td">
                          <div className="font-mono text-[12px]">{a.label || a.id}</div>
                          <div className="font-mono text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                            {a.id}
                          </div>
                        </td>
                        <td className="td">
                          <Chip tone="neutral" dot={STATE_DOT_CLASS[st]}>
                            {STATE_LABEL[st]}
                          </Chip>
                        </td>
                        <td className="td">{a.source || a.edition || '—'}</td>
                        <td className="td font-mono text-[12px]">
                          {pack ? formatQuota(pack.unlimited, pack.remaining) : '—'}
                        </td>
                        <td className="td">
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
                        <td className="td cell-num">{formatNumber(a.balance)}</td>
                        <td className="td font-mono text-[12px]">
                          {st === 'cool' && cooling ? (
                            <span style={{ color: 'var(--rg-state-warning)' }}>{cooling}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td cell-act">
                          <div className="inline-flex items-center gap-1.5">
                            <Button size="sm" disabled={busy} onClick={() => checkin(a)}>
                              签到
                            </Button>
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
          title="最近操作时间"
          description="用于判断凭据是否仍在被调度"
          flush
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th">最近选用</th>
                <th className="th">最近签到</th>
                <th className="th">签到结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((a) => (
                <tr key={a.id} className="row-hover">
                  <td className="td font-mono text-[12px]">{a.label || a.id}</td>
                  <td className="td font-mono text-[12px]">{formatTime(a.lastPickedAt)}</td>
                  <td className="td font-mono text-[12px]">{formatTime(a.lastCheckinAt)}</td>
                  <td className="td font-mono text-[12px]">{a.lastCheckinResult || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {growthOpen && <GrowthPanel />}
      </Stack>

      <OauthTraeDialog
        open={showOauth}
        onClose={() => setShowOauth(false)}
        onDone={list.reload}
      />
      <ImportWbDialog
        open={showWbImport}
        onClose={() => setShowWbImport(false)}
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
