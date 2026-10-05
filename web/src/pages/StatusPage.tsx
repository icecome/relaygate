import { useCallback, useEffect, useState } from 'react';
import StatCard from '../components/StatCard';
import { Note, Panel, ICON } from '../components/ui';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { usePrompt } from '../components/Prompt';
import {
  getStatus,
  runScheduler,
  getRotateStatus,
  runRotateNow,
  seedRotateBackups,
  switchRotateAccount,
  saveRotateSettings,
  getSchedulerSettings,
  saveSchedulerSettings,
  type RotateStatus,
} from '../api/admin';
import { relTime } from '../lib/format';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 调度配置返回值的兜底：请求失败时不能让轮换时刻回落到 00:00 造成误导 */
const FALLBACK_ROTATE_TIME = '00:10';

/** "HH:mm" → 时分；无法解析时返回 null，由调用方保留原值 */
function parseHm(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export default function StatusPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rotate, setRotate] = useState<RotateStatus | null>(null);
  const [rotBusy, setRotBusy] = useState(false);
  const [rotOn, setRotOn] = useState(true);
  const [rotStay, setRotStay] = useState('60');
  const [rotExclude, setRotExclude] = useState('');
  const [rotBack, setRotBack] = useState(true);
  const [rotTime, setRotTime] = useState(FALLBACK_ROTATE_TIME);
  const [rotStatus, setRotStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [rotErr, setRotErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!key) {
      setErr('尚未配置登录密钥，请先在「设置 · 配置」保存登录密钥。');
      setRotErr(null);
      return;
    }
    getStatus(key)
      .then((d) => {
        setStatus(d);
        setErr(null);
      })
      .catch((e: Error) => {
        // /status 受 ADMIN 保护，密钥不对或后端版本过低会 401
        setErr(`读取运行状态失败：${e.message}`);
      });
    getRotateStatus(key)
      .then((d) => {
        setRotate(d);
        setRotErr(null);
        const s = d.settings;
        if (s) {
          setRotOn(s.enabled);
          setRotStay(String(Math.round(s.stayMs / 1000)));
          setRotExclude(s.excludeUids || '');
          setRotBack(s.switchBack);
        }
      })
      .catch((e: Error) => {
        // 读取失败时面板字段整体不可信，置空并显式提示
        setRotate(null);
        setRotErr(`读取轮换状态失败：${e.message}`);
      });
    // 轮换定时时刻由调度配置承担（rotateHour / rotateMinute），单独取；
    // 失败则明确提示，不用兜底值冒充真实配置
    getSchedulerSettings(key)
      .then((d) => {
        if (typeof d.rotateHour === 'number' && typeof d.rotateMinute === 'number') {
          setRotTime(`${pad2(d.rotateHour)}:${pad2(d.rotateMinute)}`);
        }
      })
      .catch((e: Error) => {
        setRotTime(FALLBACK_ROTATE_TIME);
        setRotErr(`读取轮换定时时刻失败：${e.message}`);
      });
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  const s = status || {};
  const up = Math.floor(Number(s.uptimeSec) || 0);
  const h = Math.floor(up / 3600);
  const m = Math.floor((up % 3600) / 60);
  const acc = (s.accounts || {}) as Record<string, number>;
  const modelsUnavail = (s.models as { unavailable?: number })?.unavailable ?? 0;

  async function runCheckin() {
    try {
      const r = await runScheduler('checkin', key);
      const ok = (r.ok as unknown[]) || [];
      const failed = (r.failed as unknown[]) || [];
      toast(`已触发签到：成功 ${ok.length} 失败 ${failed.length}`);
      load();
    } catch (e) {
      toast(`触发失败：${(e as Error).message}`, 'err');
    }
  }

  // ===== 客户端账号轮换 =====
  async function saveRotate() {
    if (!key) {
      setRotStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    // 时刻解析失败时中止保存：不能只写「停留时长」而让时刻静默回退成默认值
    const hm = parseHm(rotTime);
    if (!hm) {
      setRotStatus({ msg: '定时时刻格式应为 HH:mm（如 00:10）', kind: 'err' });
      return;
    }
    try {
      // 时刻属调度配置，先存后存轮换配置：后者会重排调度，保证「落盘值 = 生效值」
      await saveSchedulerSettings({ rotateHour: hm.hour, rotateMinute: hm.minute }, key);
      const d = await saveRotateSettings(
        {
          enabled: rotOn,
          stayMs: (parseInt(rotStay, 10) || 60) * 1000,
          excludeUids: rotExclude,
          switchBack: rotBack,
        },
        key,
      );
      setRotTime(`${pad2(hm.hour)}:${pad2(hm.minute)}`);
      setRotStatus({ msg: d.enabled ? `自动切换已启用（每日 ${pad2(hm.hour)}:${pad2(hm.minute)} 执行）` : '自动切换已关闭', kind: 'ok' });
      toast('自动切换配置已保存并热重载', 'ok');
      load();
    } catch (e) {
      setRotStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function runRotate() {
    if (!key || rotBusy) return;
    setRotBusy(true);
    setRotStatus({ msg: '轮换执行中…（无备份则先由账号库生成，逐个账号停留后切换）', kind: '' });
    try {
      const r = await runRotateNow(key);
      const seeded = r.seeded?.ok?.length ?? 0;
      const parts = [`成功 ${r.ok}`, `失败 ${r.failed}`];
      if (seeded) parts.push(`自动生成备份 ${seeded} 个`);
      setRotStatus({ msg: `轮换完成：${parts.join(' · ')}`, kind: r.failed ? 'err' : 'ok' });
      toast(`账号轮换完成：${parts.join(' · ')}`, r.failed ? 'warn' : 'ok');
      load();
    } catch (e) {
      setRotStatus({ msg: `轮换失败：${(e as Error).message}`, kind: 'err' });
    } finally {
      setRotBusy(false);
    }
  }

  async function seedRotate() {
    if (!key) return;
    const ok = await prompt({ title: '生成账号备份', message: '从账号库把启用 WorkBuddy 账号的登录态写入客户端 auth 目录（已有备份的账号跳过）。无需手动登录客户端。', okText: '生成', cancelText: '取消' });
    if (!ok) return;
    try {
      const r = await seedRotateBackups(key);
      const parts = [`生成 ${r.ok?.length ?? 0} 个`, `跳过 ${r.skipped?.length ?? 0} 个`];
      if (r.failed?.length) parts.push(`失败 ${r.failed.length} 个`);
      setRotStatus({ msg: `备份生成：${parts.join(' · ')}`, kind: r.failed?.length ? 'err' : 'ok' });
      toast(`备份生成完成：${parts.join(' · ')}`, r.failed?.length ? 'warn' : 'ok');
      load();
    } catch (e) {
      setRotStatus({ msg: `备份生成失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function switchRotate(uid: string, label: string) {
    if (!key) return;
    const ok = await prompt({ title: '切换当前账号', message: `切换到「${label}」？客户端将热加载该账号登录态。`, okText: '切换', cancelText: '取消' });
    if (!ok) return;
    try {
      const r = await switchRotateAccount(uid, key);
      toast(r.ok ? `已切换到 ${r.label}` : `切换失败：${r.msg || ''}`, r.ok ? 'ok' : 'err');
      load();
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, 'err');
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <StatCard
          label="运行时长"
          value={h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`}
          hint={`进程启动至今 · ${String(s.node || '—')}`}
        />
        <StatCard
          label="账号池"
          value={acc.total ?? '—'}
          hint={`启用 ${acc.enabled || 0} · 冷却中 ${acc.cooling || 0} · 详见「账号」栏目`}
        />
        <StatCard
          label="不可用模型"
          value={modelsUnavail}
          hint={modelsUnavail > 0 ? '探活失败已隐藏，详见「统计 · 模型」' : '全部探活正常'}
          accent={modelsUnavail > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className="btn btn-primary" onClick={runCheckin}>
          立即签到
        </button>
        <span className="ml-auto text-xs text-ink-faint">
          上游令牌按需自动续期，无需手动保活
        </span>
      </div>

      <Note kind="info" icon={ICON.info}>
        <b>「立即签到」的作用对象</b>：对全部启用账号串行执行 Trae 签到 → WorkBuddy 签到 → 成长中心自动化 → 刷新余额。
        日常运维由调度器按「概览 · 今日执行链」的时刻自动完成，此按钮仅用于临时手动触发。
        上游访问令牌由每次请求按需自动续期（过期前 30 分钟），无需手动保活。
      </Note>

      {err && <Note kind="warn" icon={ICON.alert}>{err}</Note>}
      {rotErr && <Note kind="warn" icon={ICON.alert}>{rotErr}</Note>}

      {/* 客户端账号轮换：作用对象是本机凭据文件，与 API 密钥轮换无关 */}
      <Panel
        title={
          <span className="inline-flex items-center gap-2">
            客户端账号轮换
            <span className="who who-local">作用于本机凭据文件</span>
          </span>
        }
        desc="每天在指定时刻把账号库中启用的 WorkBuddy 登录态写入客户端 auth 目录，逐个替换触发客户端热加载，让每个账号都产生当日活跃记录。与「访问密钥」页的密钥轮换对象完全不同。定时时刻在本面板内调整，保存即重排调度。重启服务不会额外触发轮换。"
        right={
          <span className={`${rotate?.scheduler?.rotateEnabled && rotate?.scheduler?.enabled ? 'pill-ok' : 'pill-muted'}`}>
            {!rotOn
              ? '自动轮换已关闭'
              : rotate?.scheduler?.enabled
                ? `每日 ${pad2(Number(rotate?.scheduler?.rotateHour ?? 0))}:${pad2(Number(rotate?.scheduler?.rotateMinute ?? 0))}`
                : '调度未运行'}
          </span>
        }
        bodyClass="px-5 pb-5"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="rot-on">
              <input id="rot-on" type="checkbox" className="w-4 h-4 accent-acc" checked={rotOn} onChange={(e) => setRotOn(e.target.checked)} />
              启用自动轮换
            </label>
            <p className="text-[11px] text-ink-faint">关闭后仅保留手动「立即轮换一遍」</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="rot-time">每日轮换时刻</label>
            <input
              id="rot-time"
              type="time"
              className="field w-full"
              value={rotTime}
              onChange={(e) => setRotTime(e.target.value)}
              disabled={!rotOn}
            />
            <p className="text-[11px] text-ink-faint">到达该时刻执行一轮，保存后立即重排调度</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="rot-stay">每账号停留（秒，10–3600）</label>
            <input id="rot-stay" type="number" min={10} max={3600} className="field w-full" value={rotStay} onChange={(e) => setRotStay(e.target.value)} />
            <p className="text-[11px] text-ink-faint">换下一个账号前，让客户端保持该登录态的时长</p>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="rot-exclude">排除 uid（逗号分隔）</label>
            <input id="rot-exclude" className="field w-full font-mono text-xs" value={rotExclude} onChange={(e) => setRotExclude(e.target.value)} placeholder="如 8c44a0b8-…,925172d2-…（留空 = 全部参与）" />
            <p className="text-[11px] text-ink-faint">不参与轮换的账号，常用于保留一个账号专供其它用途</p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="rot-back">
              <input id="rot-back" type="checkbox" className="w-4 h-4 accent-acc" checked={rotBack} onChange={(e) => setRotBack(e.target.checked)} />
              轮换后切回起始账号
            </label>
            <p className="text-[11px] text-ink-faint">一轮结束后恢复轮换前的账号，避免长期停在末尾账号</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center mb-3">
          <button type="button" className="btn btn-primary" onClick={saveRotate}>
            保存并热重载
          </button>
          <button type="button" className="btn btn-ghost" onClick={runRotate} disabled={rotBusy}>
            {rotBusy ? '轮换中…' : '立即轮换一遍'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={seedRotate}>
            生成账号备份
          </button>
          <button type="button" className="btn btn-ghost" onClick={load}>刷新状态</button>
          <span className="ml-auto text-xs text-ink-faint tabular-nums">
            {rotate?.lastRotateAt ? `上次轮换 ${relTime(rotate.lastRotateAt)} · 成功 ${rotate.lastRotateOk ?? 0} / 失败 ${rotate.lastRotateFailed ?? 0}` : ''}
          </span>
        </div>
        {rotStatus.msg && (
          <div role="status" className={`text-xs mb-3 ${rotStatus.kind === 'ok' ? 'text-acc-hover' : rotStatus.kind === 'err' ? 'text-danger' : ''}`}>
            {rotStatus.msg}
          </div>
        )}

        {rotate && (
          <div className="text-xs text-ink-faint mb-3">
            当前 auth：<span className="font-mono">{rotate.currentUid ? rotate.currentUid.slice(0, 8) + '…' : '—'}</span>
            <span className="mx-2">·</span>auth 目录：<span className="font-mono">{rotate.authDir || '—'}</span>
            <span className="mx-2">·</span>账号备份：<span className="font-medium text-ink-soft">{rotate.accounts?.length ?? 0} 个</span>
          </div>
        )}

        {rotate?.accounts && rotate.accounts.length > 0 && (
          <div className="border border-line-hairline rounded-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px] min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th">账号</th>
                    <th className="th cell-num">今日活跃</th>
                    <th className="th">活跃等级</th>
                    <th className="th cell-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(rotate.accounts || []).map((a) => {
                    const hm = (rotate.heatmap || []).find((h) => h.uid === a.uid);
                    return (
                      <tr key={a.uid} className="row-hover [&>td]:px-4 [&>td]:py-2.5 align-middle [&>td]:border-b [&>td]:border-line-hairline">
                        <td>
                          <div className="font-medium">{a.label}</div>
                          <div className="font-mono text-[10px] text-ink-faint">{a.uid.slice(0, 12)}…</div>
                        </td>
                        <td className="cell-num">
                          {hm ? (
                            hm.error ? (
                              <span className="text-warn">查询失败</span>
                            ) : (
                              <span className={`${hm.isActive ? 'text-acc-hover font-medium' : 'text-ink-faint'}`}>{hm.score ?? 0} 分{hm.statusText ? `（${hm.statusText}）` : ''}</span>
                            )
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        <td>{hm && !hm.error ? <span className={`${hm.isActive ? 'pill-ok' : 'pill-muted'}`}>{hm.level || '—'}</span> : <span className="text-ink-faint">—</span>}</td>
                        <td className="cell-act">
                          <button type="button" className="btn-quiet" onClick={() => switchRotate(a.uid, a.label)}>
                            切换
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {rotate && (!rotate.accounts || rotate.accounts.length === 0) && (
          <div className="text-xs text-ink-faint">
            auth 目录未发现账号备份。可直接用「立即轮换一遍」让 RelayGate 从账号库生成备份（无需手动登录客户端）。
          </div>
        )}
      </Panel>
    </div>
  );
}