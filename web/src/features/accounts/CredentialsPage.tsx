/**
 * 凭据池页：账号凭据的启用、签到、余额与设备重置。
 *
 * 所有操作均对应 /v1/credentials 真实接口，无虚构能力。
 *
 * 页面结构（自上而下，信息频率递减）：
 *   1. 统计条        —— 账号数 / 积分额度 / 临期 / 待处理，一行
 *   2. 平台接入 rail  —— 5 个平台压成一条 56px 的横条（原来是 640–700px 的卡片墙）
 *   3. 工具条        —— 搜索 + 平台 + 状态 + 分组
 *   4. 凭据表        —— 9 列，主任务
 *   5. 权益总览      —— 按平台一行，可展开明细（多平台额度）
 *   6. 成长中心      —— 默认收起为一行摘要，零上游请求
 *   7. 最近操作与保活 —— 逐池分组
 *
 * 「首页最小化、详情跳转」的三处落点：
 *   - 渠道接入：rail 只留主按钮 + ⋯ → ChannelDetailDialog / 各接入向导
 *   - 权益：列表只显示摘要（后端 ?slim=1）→ EntitlementDialog 按需拉完整明细
 *   - 成长：收起态只读 last-run 文件，展开才拉上游
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import {
  checkinAll,
  checkinOne,
  deleteAccount,
  listAccountsWithRollup,
  listGroups,
  patchAccount,
  refreshOneBalance,
  resetAllDevices,
  resetOneDevice,
} from '../../shared/api/credentials';
import { wbCheckin as wbCheckinOne, wbRefresh } from '../../shared/api/workbuddy';
import { listChannels, type Channel } from '../../shared/api/channels';
import { ApiError } from '../../shared/api/http';
import { runAction, summarizeBatch } from '../../shared/api/action';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { useBalanceAutoRefresh } from '../../shared/hooks/useBalanceAutoRefresh';
import { channelEntry, type WizardKind } from '../../shared/lib/channels';
import {
  accountState,
  coolRemaining,
  formatDate,
  formatNumber,
  formatTime,
  platformIdLabel,
  platformLabel,
  platformOf,
  STATE_DOT_CLASS,
  STATE_LABEL,
} from '../../shared/lib/format';
import {
  amountUnitOf,
  entitlementOf,
  entitlementCellText,
  type EntitlementSummary,
} from '../../shared/lib/entitlement';
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
import { MenuButton, type MenuItem } from '../../shared/ui/Menu';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';
import { ImportTraeDialog } from './ImportTraeDialog';
import { ImportWbDialog } from './ImportWbDialog';
import { ImportQoderDialog } from './ImportQoderDialog';
import { ImportZcodeDialog } from './ImportZcodeDialog';
import { ImportRaccoonDialog } from './ImportRaccoonDialog';
import { OauthTraeDialog } from './OauthTraeDialog';
import { WbOauthDialog } from './WbOauthDialog';
import { TransferDialog } from './TransferDialog';
import { ChannelRail } from './ChannelRail';
import { ChannelDetailDialog } from './ChannelDetailDialog';
import { ChannelOpsDialog } from './ChannelOpsDialog';
import { GrowthPanel } from './GrowthPanel';
import { EntitlementOverview } from './EntitlementOverview';
import { EntitlementDialog } from './EntitlementDialog';
import { keepaliveOf } from './accountPacks';
import { KeepaliveBoard } from './KeepaliveBoard';
import { AccountAttrsDialog } from './AccountAttrsDialog';

type StateFilter = 'all' | 'ok' | 'cool' | 'off';

/**
 * 账号表排序档位。
 *
 * 此前 `rows` 的 useMemo 只有 filter、没有 sort——「过滤与排序均为派生值」
 * 那句注释里排序是不存在的。日常最常用的「哪个号快用完了」「哪个号快到期了」
 * 只能靠肉眼扫 23 行。
 *
 * 四档的取舍（对齐 pool.js 的调度语义，让人能核对调度是否与直觉一致）：
 *   recent   最近选用：被调度过的在前，用于确认某个号到底有没有被用到
 *   balance  额度升序：先看「快用完了」的，补号/降级前的第一眼
 *   expiry   到期升序：先看「快到期」的，对应后端 FEFO 先到期先用
 *   platform 平台分组：跨平台对照时按平台聚拢
 */
type SortKey = 'recent' | 'balance' | 'expiry' | 'platform';

const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  { value: 'recent', label: '最近选用' },
  { value: 'balance', label: '额度低优先' },
  { value: 'expiry', label: '到期近优先' },
  { value: 'platform', label: '按平台' },
];

export default function CredentialsPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [searchParams] = useSearchParams();

  /**
   * 初始筛选词来自 `?q=`。
   *
   * 命令面板（Ctrl K）搜到账号后跳到本页会带这个参数；不带就等于跳过来还得
   * 再搜一次，命令面板的价值砍半。只在首次挂载时读一次，之后由用户自己改。
   */
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  /** 分组筛选：空串 = 全部分组。分组名来自后端 /v1/credentials/groups。 */
  const [groupFilter, setGroupFilter] = useState('');
  /** 排序档位：default 取「最近选用」，与后端 store.list() 的插入顺序脱钩 */
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  /**
   * 权益总览展开态。默认展开：它是本页第二块，且是「还剩多少」的唯一答案。
   * 收起态只留一行摘要 —— 需要连续浏览凭据表的人可以一键换回高度。
   */
  const [entOpen, setEntOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showOauth, setShowOauth] = useState(false);
  const [showWbOauth, setShowWbOauth] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showWbImport, setShowWbImport] = useState(false);
  const [showQoderImport, setShowQoderImport] = useState(false);
  const [showZcodeImport, setShowZcodeImport] = useState(false);
  const [showRaccoonLogin, setShowRaccoonLogin] = useState(false);
  const [showImport, setShowImport] = useState(false);

  /** 权益详情（单账号）：null 表示关闭。数据按需拉取。 */
  const [entTarget, setEntTarget] = useState<Account | null>(null);
  /** 编辑调度属性（分组/成本档/标签）的账号 */
  const [attrsTarget, setAttrsTarget] = useState<Account | null>(null);
  /** 需要重新登录的账号 */
  const [reloginTarget, setReloginTarget] = useState<Account | null>(null);
  /** 正在查看运营面的渠道（套餐 / 积分领取） */
  const [opsChannel, setOpsChannel] = useState<Channel | null>(null);
  /** 正在查看接入详情的渠道 */
  const [detailChannel, setDetailChannel] = useState<Channel | null>(null);

  /**
   * 账号列表：**带 slim**，每个账号的 packs 换成 packDigest 摘要。
   * 实测 23 个账号 743 条包时，完整响应 121 KB、摘后 ≈18 KB。
   * 这是一条每 60 秒跑一次的轮询路径，不该每次下发 743 条明细。
   * 完整明细走 EntitlementDialog 的按需拉取。
   */
  const list = useAsyncData(
    (signal) => listAccountsWithRollup(key, signal),
    [key],
    { enabled: !!key },
  );

  // 渠道接入清单：能力位、账号计数、本机客户端探测结果。
  // 平台名单来自后端（platform/variant.js），前端不写死。
  const channels = useAsyncData(
    (signal) => listChannels(key, signal),
    [key],
    { enabled: !!key },
  );

  // 分组清单（/v1/credentials/groups）
  const groups = useAsyncData(
    (signal) => listGroups(key, signal),
    [key],
    { enabled: !!key },
  );

  const { reload: reloadList } = list;
  const { reload: reloadChannels } = channels;
  const { reload: reloadSummary } = useSummaryStore();
  const reloadAfterBalance = useCallback(() => {
    reloadList();
    reloadSummary();
  }, [reloadList, reloadSummary]);
  useBalanceAutoRefresh(key, reloadAfterBalance);

  /**
   * 接入 / 运营面写操作后的统一刷新：账号列表、渠道计数、侧栏汇总一起走。
   * 刻意不并进 60 秒的余额轮询——渠道清单里的本机客户端探测是磁盘读取，
   * 没有理由跟着余额一起每分钟跑一遍。
   */
  const reloadAll = useCallback(() => {
    reloadList();
    reloadChannels();
    reloadSummary();
    groups.reload();
  }, [reloadList, reloadChannels, reloadSummary, groups]);

  /**
   * 用 useMemo 固定引用：下方多个 useMemo（platformOptions / rows / stats /
   * workbuddyCount）都以它为依赖，`?? []` 每次渲染都会造一个新数组，
   * 不包住就等于那些 memo 全部失效（lint 的 exhaustive-deps 正是报这个）。
   */
  const allAccounts = useMemo(() => list.data?.accounts ?? [], [list.data]);

  /** 按平台计数（工具条下拉用，同时避免 Segmented 六项占 400px 导致换行）。 */
  const platformOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of allAccounts) {
      const p = platformOf(a);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const opts = [{ value: 'all', label: `全部平台（${allAccounts.length}）` }];
    for (const [p, n] of counts) {
      opts.push({ value: p, label: `${platformIdLabel(p)}（${n}）` });
    }
    return opts;
  }, [allAccounts]);

  // 过滤与排序均为派生值，不写入 state
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allAccounts.filter((a) => {
      const st = accountState(a);
      if (stateFilter !== 'all' && st !== stateFilter) return false;
      if (platformFilter !== 'all' && platformOf(a) !== platformFilter) return false;
      if (groupFilter) {
        // '__ungrouped__' 是后端 groups 汇总里 name=null 的显示键
        if (groupFilter === '__ungrouped__' ? a.group != null : a.group !== groupFilter) return false;
      }
      if (q) {
        const hay = `${a.label ?? ''} ${a.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    /**
     * 排序。缺值一律沉底（`Infinity`），不用 0 顶替 —— 0 会让「从未选用」
     * 的账号排到「刚刚用过」的前面，正好把用户要看的那个藏起来。
     */
    const tsOf = (v: string | null | undefined) => {
      if (!v) return Number.POSITIVE_INFINITY;
      const t = new Date(v).getTime();
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    };
    const out = filtered.slice();
    out.sort((a, b) => {
      if (sortKey === 'balance') {
        // 额度升序：没查过余额的（null）沉底，而不是当 0 排最前
        const av = typeof a.balance === 'number' ? a.balance : Number.POSITIVE_INFINITY;
        const bv = typeof b.balance === 'number' ? b.balance : Number.POSITIVE_INFINITY;
        return av - bv || tsOf(b.lastPickedAt) - tsOf(a.lastPickedAt);
      }
      if (sortKey === 'expiry') {
        // 到期升序：无到期（长期有效）沉底
        return tsOf(a.expiredAt) - tsOf(b.expiredAt);
      }
      if (sortKey === 'platform') {
        const p = platformOf(a);
        const qp = platformOf(b);
        return p.localeCompare(qp) || tsOf(b.lastPickedAt) - tsOf(a.lastPickedAt);
      }
      // recent：最近选用在前
      return tsOf(b.lastPickedAt) - tsOf(a.lastPickedAt);
    });
    return out;
  }, [allAccounts, query, stateFilter, platformFilter, groupFilter, sortKey]);

  /**
   * 统计条数据。
   *
   * 额度一行只报**积分口径**（rollup.usableAmount，来自后端 slim 响应）：
   * 这是唯一可相加的口径（Trae + WorkBuddy）。Token 与配额分列在权益总览里，
   * 混进来会让这个数变成一个没有意义的和。
   */
  const rollup = list.data?.rollup ?? null;
  const stats = useMemo(() => {
    let cooling = 0;
    let off = 0;
    let needRelogin = 0;
    for (const a of allAccounts) {
      const st = accountState(a);
      if (st === 'cool') cooling += 1;
      else if (st === 'off') off += 1;
      if (keepaliveOf(a).tone === 'danger') needRelogin += 1;
    }
    return { cooling, off, needRelogin };
  }, [allAccounts]);

  const workbuddyCount = useMemo(
    () => allAccounts.filter((a) => platformOf(a) === 'workbuddy').length,
    [allAccounts],
  );

  /** 分组下拉选项：未分组固定排在最后。 */
  const groupOptions = useMemo(() => {
    const named = (groups.data?.data ?? [])
      .filter((g) => g.name != null)
      .map((g) => ({ value: String(g.name), label: `${g.name}（${g.count}）` }));
    const ungrouped = (groups.data?.data ?? []).find((g) => g.name == null);
    if (ungrouped) named.push({ value: '__ungrouped__', label: `未分组（${ungrouped.count}）` });
    return named;
  }, [groups.data]);

  /**
   * 渠道 id → 渠道对象 / 能力位。
   * 行内按钮显示什么一律读后端能力位，不按平台名硬编码：
   * 此前是 `platformOf(a) !== 'zcode' && !== 'qoder'`，新增平台时必然漏改，
   * 且漏改的表现是「按钮显示但后端拒绝」或「有能力的平台没有按钮」。
   */
  const channelById = useMemo(() => {
    const out: Record<string, Channel> = {};
    for (const c of channels.data?.data ?? []) out[c.id] = c;
    return out;
  }, [channels.data]);

  /** 统一包装写操作：错误必须展示到 UI，不能只写入 console。 */
  async function run(id: string, label: string, fn: () => Promise<unknown>, successMsg: string) {
    setBusyId(id);
    try {
      return await runAction({ label, fn, successMsg, toast, onDone: list.reload });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(a: Account) {
    await run(
      a.id,
      a.enabled ? '停用' : '启用',
      () => patchAccount(a.id, { enabled: !a.enabled }, key),
      a.enabled ? '已停用' : '已启用',
    );
  }

  async function checkin(a: Account) {
    // 按平台分发：WorkBuddy 走它自己的签到端点（/v1/workbuddy/checkin），Trae 系走通用端点。
    // 文案按结果分级：claimed=false 的「停用 / 上游没发分」不能报成功。
    const label = a.label || a.id;
    const fn = platformOf(a) === 'workbuddy'
      ? () => wbCheckinOne({ accountId: a.id }, key)
      : () => checkinOne(a.id, key);
    setBusyId(a.id);
    try {
      const r = (await fn()) as {
        claimed?: boolean;
        result?: string;
        note?: string;
        reason?: string;
        streakDays?: number | null;
        checkinCredits?: number | null;
      };
      if (r.claimed) {
        toast(`签到完成：${label} +${r.checkinCredits ?? '?'} 分（连续 ${r.streakDays ?? '-'} 天）`, 'ok');
      } else if (r.result === 'already') {
        toast(`今日已签到：${label}（连续 ${r.streakDays ?? '-'} 天）`, 'ok');
      } else {
        const why = r.result === 'disabled'
          ? '签到功能未对该账号开启'
          : (r.note || r.reason || '上游未返回签到结果，积分未到账');
        toast(`签到未到账：${label} —— ${why}`, 'warn');
      }
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : `签到请求失败：${label}`, 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function checkinEveryOne() {
    setBusyId('__all__');
    try {
      const r = await checkinAll(key);
      const claimed = r.claimed ?? 0;
      const already = r.already ?? 0;
      const failed = r.failed ?? 0;
      if (r.skipped) {
        toast(r.message || '另一轮签到正在进行，本次已跳过', 'warn');
      } else if (failed > 0) {
        const reasons = (r.platforms ?? [])
          .flatMap((p) => p.accounts.filter((x) => !x.result || /fail|error|未/i.test(x.result)))
          .slice(0, 3)
          .map((x) => [x.label, x.reason].filter(Boolean).join('：'))
          .filter(Boolean)
          .join('；');
        toast(
          `签到完成（${claimed} 新签 / ${already} 已签 / ${failed} 失败）：${r.message ?? ''}${reasons ? `；${reasons}` : ''}`,
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

  /** WorkBuddy 手动换票：新到期时间才是用户关心的信息。 */
  async function refreshWbToken(a: Account) {
    const label = a.label || a.id;
    setBusyId(a.id);
    try {
      const r = await wbRefresh({ accountId: a.id }, key);
      toast(`Token 已刷新，新到期时间 ${formatTime(r.expiredAt)}`, 'ok');
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : `Token 刷新失败：${label}`, 'err');
    } finally {
      setBusyId(null);
    }
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

  /** 单账号重置设备标识（后端一直有这条端点，此前前端只接了「全部重置」）。 */
  async function resetOne(a: Account) {
    const ok = await prompt({
      title: `重置 ${a.label || a.id} 的设备标识？`,
      message: '将生成新的设备标识，下次请求立即生效。不改动凭据与路由配置。',
      okText: '重置',
      danger: true,
    });
    if (ok !== true) return;
    await run(a.id, '重置设备标识', () => resetOneDevice(a.id, key), '设备标识已重置');
  }

  /** 打开接入向导。向导种类由渠道注册表解析，调用方只说「哪条接入方式」。 */
  function openWizard(kind: WizardKind) {
    if (kind === 'trae-oauth') setShowOauth(true);
    else if (kind === 'trae-paste') setShowImport(true);
    else if (kind === 'wb-oauth') setShowWbOauth(true);
    else if (kind === 'wb-local') setShowWbImport(true);
    else if (kind === 'qoder-local') setShowQoderImport(true);
    else if (kind === 'qoder-manual') setShowQoderImport(true);
    else if (kind === 'zcode-local') setShowZcodeImport(true);
    else if (kind === 'raccoon-login') setShowRaccoonLogin(true);
    else if (kind === 'raccoon-local') setShowRaccoonLogin(true);
  }

  /**
   * 行内「重新登录」：token / refreshToken 已过期的账号无法自愈，
   * 按渠道注册表路由到本平台的重新接入向导。
   */
  function relogin(a: Account) {
    const entry = channelEntry(platformOf(a));
    const kind = entry?.wizards.oauth ?? entry?.wizards.local ?? entry?.wizards.login ?? null;
    if (!kind) {
      toast(`该渠道暂无可用的重新登录向导：${a.label || a.id}`, 'warn');
      return;
    }
    if (kind === 'trae-oauth') {
      setReloginTarget(a);
    } else {
      toast(`请在「${platformLabel(a)}」接入向导里重新获取登录态：${a.label || a.id}`, 'warn');
    }
    openWizard(kind);
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

  /**
   * 行内操作：2 个主按钮 + ⋯ 菜单。
   *
   * 主按钮按能力位推导，不写死平台名：
   *   - 有 checkin 能力 → 「签到」
   *   - 有 rewardClaim 能力 → 「领取」
   *   - 有 loginReward 能力 → 「奖励」
   *   - 第二个固定是查额度（有 balance 能力时）
   * 其余（属性 / 重置设备 / 刷新 Token / 重新登录 / 导出 / 删除）进菜单。
   * 此前 7 个按钮平铺在 200px 里，21 行全部折行、行高从 40px 变 72px。
   */
  function rowActions(a: Account, cap: Channel['capability'] | undefined): {
    primary: { label: string; onClick: () => void; disabled: boolean }[];
    menu: MenuItem[];
  } {
    const busy = busyId === a.id;
    const pf = platformOf(a);
    const primary: { label: string; onClick: () => void; disabled: boolean }[] = [];

    if (cap?.checkin === true) {
      primary.push({ label: '签到', onClick: () => checkin(a), disabled: busy });
    } else if (cap?.rewardClaim === true) {
      primary.push({
        label: '领取',
        onClick: () => setOpsChannel(channelById[pf] ?? null),
        disabled: busy,
      });
    } else if (cap?.loginReward === true) {
      primary.push({
        label: '奖励',
        onClick: () => setOpsChannel(channelById[pf] ?? null),
        disabled: busy,
      });
    }

    // 第二个主按钮：查额度。所有平台都声明了 balance 能力（实测 5/5）。
    primary.push({
      label: pf === 'zcode' || pf === 'qoder' ? '查额度' : '查余额',
      onClick: () => checkBalance(a),
      disabled: busy,
    });

    const needRelogin = keepaliveOf(a).tone === 'danger';
    const menu: MenuItem[] = [
      {
        key: 'ent',
        label: '权益明细',
        onSelect: () => setEntTarget(a),
        hint: `${entitlementCellText(entitlementOf(a))}`,
      },
      {
        key: 'attrs',
        label: '调度属性',
        onSelect: () => setAttrsTarget(a),
        hint: '分组 / 成本档 / 标签',
      },
      {
        key: 'copy',
        label: '复制账号 ID',
        onSelect: () => {
          void navigator.clipboard?.writeText(a.id).then(
            () => toast('账号 ID 已复制', 'ok'),
            () => toast('复制失败，请手动选择', 'err'),
          );
        },
      },
    ];

    if (needRelogin) {
      menu.push({
        key: 'relogin',
        label: '重新登录',
        groupStart: true,
        onSelect: () => relogin(a),
        hint: 'refreshToken 已过期，无法自动恢复',
      });
    }
    if (cap?.deviceFingerprint === true) {
      menu.push({
        key: 'device',
        label: '重置设备标识',
        groupStart: !needRelogin,
        onSelect: () => void resetOne(a),
        hint: '生成新的设备指纹，下次请求生效',
      });
    }
    if (pf === 'workbuddy' && cap?.tokenRefresh === true) {
      menu.push({
        key: 'refreshToken',
        label: '刷新 Token',
        onSelect: () => void refreshWbToken(a),
        hint: '上游提前作废 token 时立即自愈',
      });
    }
    menu.push({
      key: 'del',
      label: '删除',
      danger: true,
      groupStart: true,
      onSelect: () => void remove(a),
    });

    return { primary, menu };
  }

  return (
    <PageShell
      title="凭据池"
      description="接入、启用与排查上游账号凭据"
      actions={
        <>
          <Button onClick={() => setShowTransfer(true)}>导入 / 导出</Button>
          <Button onClick={checkinEveryOne} disabled={busyId === '__all__'}>
            {busyId === '__all__' ? '执行中' : '全部签到'}
          </Button>
          <Button variant="primary" onClick={reloadAll}>
            刷新
          </Button>
        </>
      }
    >
      <Stack>
        {list.error && <ErrorState message={list.error} onRetry={list.reload} />}

        {/*
          统计条：只报**账号健康**（数量 / 停用 / 冷却 / 需重登）。
          额度相关三项（可用积分 / 可用权益包 / 7 日内到期）已随权益总览
          上移到下方，避免同一屏出现两处相同的「可用积分」。
        */}
        <div className="stat-strip">
          <span>
            账号 <strong>{formatNumber(allAccounts.length)}</strong>
            {stats.off > 0 && ` · 停用 ${formatNumber(stats.off)}`}
            {stats.cooling > 0 && (
              <span style={{ color: 'var(--rg-state-warning)' }}> · 冷却 {formatNumber(stats.cooling)}</span>
            )}
          </span>
          {allAccounts.length > 0 && (
            <span>
              启用中 <strong>{formatNumber(allAccounts.length - stats.off)}</strong>
            </span>
          )}
          {stats.needRelogin > 0 ? (
            <Chip tone="danger" dot="dot-error">
              {stats.needRelogin} 个账号需重新登录
            </Chip>
          ) : (
            allAccounts.length > 0 && (
              <span style={{ color: 'var(--rg-text-tertiary)' }}>登录态正常</span>
            )
          )}
        </div>

        {/*
          权益总览：**提到统计条之下、平台接入之上**。
          进页面的第一问题是「各平台还剩多少、哪些快到期」，不是「怎么接入新平台」。
          此前它在凭据表之后（第 4 位），必须滚过整张表才能看到。
          积分口径汇总（原统计条那三个数）由 rollup prop 传入，不在此重算。
        */}
        <Panel
          id="entitlement-overview"
          title="权益总览"
          description="按平台分行展示各自口径的额度；点行展开账号明细"
          flush
          actions={
            <Button size="sm" variant="ghost" onClick={() => setEntOpen((v) => !v)}>
              {entOpen ? '收起' : '展开'}
            </Button>
          }
        >          {entOpen ? (
            <div className="p-0">
              <EntitlementOverview accounts={allAccounts} rollup={rollup} />
            </div>
          ) : (
            /*
              收起态：一行摘要，仍是零额外请求（数据已在 list.data 里）。
              必须有摘要而不是留空，否则「收起」与「没有数据」在视觉上无法区分。
            */
            <div
              className="flex items-center flex-wrap gap-x-5 gap-y-1 px-4 py-2.5 text-aux"
              style={{ color: 'var(--rg-text-secondary)' }}
            >
              <span title="仅统计积分口径（Trae + WorkBuddy）">
                积分口径合计{' '}
                <strong className="font-mono" style={{ color: 'var(--rg-text-primary)' }}>
                  {formatNumber(rollup?.usableAmount ?? 0)}
                </strong>
              </span>
              <span>
                可用权益包{' '}
                <strong className="font-mono" style={{ color: 'var(--rg-text-primary)' }}>
                  {formatNumber(rollup?.usable ?? 0)}
                </strong>
              </span>
              {rollup && rollup.expiring7d > 0 ? (
                <span style={{ color: 'var(--rg-state-warning)' }}>
                  7 日内到期 <strong className="font-mono">{formatNumber(rollup.expiring7d)}</strong>
                </span>
              ) : (
                <span style={{ color: 'var(--rg-text-tertiary)' }}>7 日内无到期积分</span>
              )}
              <span style={{ color: 'var(--rg-text-tertiary)' }}>
                {new Set(allAccounts.map((a) => platformOf(a))).size} 个平台
              </span>
            </div>
          )}
        </Panel>

        {/*
          渠道接入：单行 rail。能力位来自 platform/variant.js，
          每条接入方式能不能点来自本机客户端实测，前端不写死平台名单。
        */}
        <Panel flush>
          <ChannelRail
            channels={channels}
            onWizard={openWizard}
            onOps={setOpsChannel}
            onDetail={setDetailChannel}
            onReload={reloadAll}
          />
        </Panel>

        <Panel flush>
          {/* 工具条：搜索 + 平台下拉（带计数）+ 状态分段 + 分组下拉 */}
          <div className="toolbar" style={{ margin: 0, border: 0, borderRadius: 0 }}>
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <div className="w-[200px]">
                <Field
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="按账号标签或 ID 筛选"
                  aria-label="按账号标签或 ID 筛选"
                />
              </div>
              {/*
                平台筛选用原生 select 而不是 Segmented：6 项 Segmented 独占 ≈400px，
                与状态筛选、分组下拉合计 >1000px，导致工具条必然换行。
                选项里带计数，比纯 Segmented 信息量更高。
              */}
              <select
                className="h-8 rounded-md border px-2 text-[13px]"
                style={{
                  borderColor: 'var(--rg-border-stronger)',
                  background: 'var(--rg-bg-base)',
                  color: 'var(--rg-text-primary)',
                }}
                aria-label="按平台筛选"
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
              >
                {platformOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
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
              {groupOptions.length > 1 && (
                <select
                  className="h-8 rounded-md border px-2 text-[13px] max-w-[180px]"
                  style={{
                    borderColor: 'var(--rg-border-stronger)',
                    background: 'var(--rg-bg-base)',
                    color: 'var(--rg-text-secondary)',
                  }}
                  aria-label="按分组筛选"
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                >
                  <option value="">全部分组</option>
                  {groupOptions.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
              )}
              {/*
                排序：此前工具栏只有 filter，`rows` 的 useMemo 里也没有 sort。
                「哪个号额度快用完」「哪个号最早到期」只能肉眼扫 23 行。
              */}
              <select
                className="h-8 rounded-md border px-2 text-[13px]"
                style={{
                  borderColor: 'var(--rg-border-stronger)',
                  background: 'var(--rg-bg-base)',
                  color: 'var(--rg-text-secondary)',
                }}
                aria-label="账号排序"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="text-aux shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
              共 {rows.length} 个账号
            </span>
          </div>

          {list.loading && !list.data ? (
            <LoadingBlock />
          ) : allAccounts.length === 0 ? (
            <EmptyState
              label="还没有接入任何账号"
              hint="接入上游账号后才能转发请求；上方平台条上点「接入」开始。"
              action={{ label: '接入第一个账号', onClick: () => setShowOauth(true) }}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              label="当前筛选条件下没有匹配账号"
              hint={`库中共有 ${allAccounts.length} 个账号。`}
              action={{
                label: '清除筛选',
                onClick: () => {
                  setQuery('');
                  setStateFilter('all');
                  setPlatformFilter('all');
                  setGroupFilter('');
                },
              }}
            />
          ) : (
            /*
             * 横向滚动只加在这一层（.table-wrap 显式 overflow-y: hidden）。
             * 绝不能加在上层 panel-body 上：CSS 规定「一轴 auto、另一轴 visible」
             * 时 visible 会被算成 auto，于是面板体变成纵向滚动容器，
             * 与外层 main 的 overflow-y: auto 叠成两条纵向滚动条。
             */
            <div className="table-wrap">
              <table className="data-table table-fixed">
                <thead>
                  <tr>
                    <th className="th col-toggle">启用</th>
                    {/*
                      账号列不设固定宽：table-fixed 下它会吃掉剩余空间。
                      min-width 是给窄窗口的下限——低于它时表格横向滚动，
                      而不是把账号名压成 1px 的竖条（1105px 窗口实测会这样）。
                    */}
                    <th className="th" style={{ minWidth: 150 }}>账号</th>
                    <th className="th col-source">平台</th>
                    <th className="th col-state">状态</th>
                    <th className="th col-pack">权益</th>
                    <th className="th col-token cell-num">额度</th>
                    <th className="th col-expiry">有效期</th>
                    <th className="th col-cool">冷却</th>
                    <th className="th col-actions cell-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const st = accountState(a);
                    const cooling = coolRemaining(a.coolUntil);
                    const pf = platformOf(a);
                    const cap = channelById[pf]?.capability;
                    const e = entitlementOf(a);
                    const keepalive = keepaliveOf(a);
                    const { primary, menu } = rowActions(a, cap);
                    // 账号列的次行：分组 / 成本档 / 标签里非空的前两项（id 移进菜单）
                    const subBits: string[] = [];
                    if (a.group) subBits.push(a.group);
                    if (a.costTier != null && a.costTier !== 1) {
                      subBits.push(a.costTier === 0 ? '免费额度' : '收费额度');
                    }
                    if (Array.isArray(a.tags) && a.tags.length) subBits.push(a.tags.slice(0, 2).join('/'));

                    return (
                      <tr key={a.id} className="row-hover">
                        <td className="td">
                          <Button
                            size="sm"
                            variant={a.enabled ? 'primary' : 'default'}
                            disabled={busyId === a.id}
                            onClick={() => toggleEnabled(a)}
                            aria-pressed={a.enabled}
                            aria-label={a.enabled ? '停用该账号' : '启用该账号'}
                          >
                            {a.enabled ? '停用' : '启用'}
                          </Button>
                        </td>
                        <td className="td">
                          <div className="truncate text-[13px]" title={`${a.label || a.id}\nID: ${a.id}`}>
                            {a.label || a.id}
                          </div>
                          <div className="truncate text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                            {subBits.length ? subBits.join(' · ') : <span className="font-mono">{a.id}</span>}
                          </div>
                        </td>
                        <td className="td whitespace-nowrap">{platformIdLabel(pf)}</td>
                        <td className="td">
                          <Chip tone="neutral" dot={STATE_DOT_CLASS[st]}>
                            {STATE_LABEL[st]}
                          </Chip>
                          {(a.errorCount ?? 0) > 0 && (
                            <Chip tone="danger">{`错误 ${a.errorCount}`}</Chip>
                          )}
                        </td>
                        {/* 权益列：跨平台统一文案。点开是权益明细弹窗（按需拉完整数据）。 */}
                        <td className="td">
                          <button
                            type="button"
                            className="inline-flex items-center max-w-full truncate text-[13px] underline decoration-dotted"
                            onClick={() => setEntTarget(a)}
                            aria-haspopup="dialog"
                            aria-label={`查看 ${a.label || a.id} 的权益明细`}
                            title={entitlementTitle(e)}
                            style={{
                              color:
                                e.tone === 'expired' || e.tone === 'critical'
                                  ? 'var(--rg-state-error)'
                                  : e.tone === 'warning'
                                    ? 'var(--rg-state-warning)'
                                    : 'var(--rg-text-primary)',
                            }}
                          >
                            {entitlementCellText(e)}
                          </button>
                        </td>
                        <td className="td cell-num">
                          <span title={`${amountUnitOf(e)}计量`}>
                            <EntAmount e={e} />
                          </span>
                        </td>
                        {/* 有效期 = 登录 token 的到期，与权益到期是两套口径 */}
                        <td className="td">
                          <span
                            className="font-mono text-aux whitespace-nowrap"
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
                                  className="ml-1.5"
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
                        <td className="td td-mono">
                          {st === 'cool' && cooling ? (
                            <span style={{ color: 'var(--rg-state-warning)' }}>{cooling}</span>
                          ) : null}
                        </td>
                        <td className="td cell-act">
                          <div className="td-actions">
                            {primary.map((b) => (
                              <Button
                                key={b.label}
                                size="sm"
                                disabled={b.disabled}
                                onClick={b.onClick}
                              >
                                {b.label}
                              </Button>
                            ))}
                            <MenuButton
                              label={`${a.label || a.id} 的更多操作`}
                              items={menu}
                              width={200}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/*
            表尾单独成行，放在 .table-wrap 之外：它不是表格的一部分，
            留在里面会被横向滚动一起带走。
          */}
          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5 border-t text-aux"
            style={{ borderColor: 'var(--rg-border)', color: 'var(--rg-text-secondary)' }}
          >
            <span>余额每 60 秒自动刷新一次，仅在页面可见时执行</span>
            <Button size="sm" onClick={resetDevices} disabled={busyId === '__dev__'}>
              {busyId === '__dev__' ? '重置中' : '重置全部设备标识'}
            </Button>
          </div>
        </Panel>

        {/*
          权益总览已上移到统计条之下（见上方），这里不再重复渲染。
          成长中心：默认收起为一行摘要（零上游请求），展开才拉。
        */}
        <GrowthPanel workbuddyCount={workbuddyCount} />

        <Panel
          title="最近操作与保活"
          description="按账号池分别统计：每个池自己的保活时刻、结果与 token 临期数"
          flush
        >
          <KeepaliveBoard accounts={allAccounts} channelById={channelById} rows={rows} />
        </Panel>
      </Stack>

      <OauthTraeDialog
        open={showOauth}
        presetLabel={reloginTarget?.label ?? reloginTarget?.id ?? undefined}
        onClose={() => {
          setShowOauth(false);
          setReloginTarget(null);
        }}
        onDone={reloadAll}
      />
      <WbOauthDialog open={showWbOauth} onClose={() => setShowWbOauth(false)} onDone={reloadAll} />
      <TransferDialog open={showTransfer} onClose={() => setShowTransfer(false)} onDone={reloadAll} />
      <ImportWbDialog open={showWbImport} onClose={() => setShowWbImport(false)} onImported={reloadAll} />
      <ImportQoderDialog open={showQoderImport} onClose={() => setShowQoderImport(false)} onImported={reloadAll} />
      <ImportZcodeDialog open={showZcodeImport} onClose={() => setShowZcodeImport(false)} onImported={reloadAll} />
      <ImportRaccoonDialog
        open={showRaccoonLogin}
        onClose={() => setShowRaccoonLogin(false)}
        onImported={reloadAll}
      />
      <ImportTraeDialog open={showImport} onClose={() => setShowImport(false)} onImported={reloadAll} />
      <ChannelOpsDialog channel={opsChannel} onClose={() => setOpsChannel(null)} onChanged={reloadAll} />
      <ChannelDetailDialog
        channel={detailChannel}
        onClose={() => setDetailChannel(null)}
        onWizard={openWizard}
      />
      <EntitlementDialog account={entTarget} onClose={() => setEntTarget(null)} />
      <AccountAttrsDialog account={attrsTarget} onClose={() => setAttrsTarget(null)} onSaved={reloadAll} />
    </PageShell>
  );
}


/** 额度读数：数值 + 单位后缀（单位走 .text-unit，11px）。 */
function EntAmount({ e }: { e: EntitlementSummary }) {
  if (!e.known || e.amount == null) {
    return <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>;
  }
  return (
    <>
      {formatNumber(e.amount)} <span className="text-unit">{amountUnitOf(e)}</span>
    </>
  );
}

/** 权益列的悬停说明：把口径讲清楚，不靠猜。 */
function entitlementTitle(e: EntitlementSummary): string {
  const unit = amountUnitOf(e);
  const lines = [
    `${unit}计量：${e.amountText}${e.amount != null ? ` ${unit}` : ''}`,
    e.detailText,
    `到期：${e.expiryText}`,
  ];
  if (e.snapshotAt) lines.push(`快照：${formatTime(e.snapshotAt)}`);
  else lines.push('快照：从未查询');
  if (e.stale) lines.push('⚠ 该快照已超过 24 小时未更新');
  lines.push('点击查看明细');
  return lines.join('\n');
}
