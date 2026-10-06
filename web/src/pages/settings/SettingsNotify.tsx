import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../stores/useAuth';
import { useToast } from '../../components/Toast';
import { usePrompt } from '../../components/Prompt';
import {
  getNotifySettings,
  saveNotifySettings,
  testNotify,
  addNotifyEvent,
  removeNotifyEvent,
  type NotifySettings,
  type NotifyEventPrefs,
} from '../../api/admin';
import SettingsBackup from './SettingsBackup';

type ChannelId = 'webhook' | 'serverchan' | 'pushplus' | 'telegram';
type EventId = keyof NotifyEventPrefs;
type Status = { msg: string; kind: '' | 'ok' | 'err' };

const CHANNEL_META: { id: ChannelId; label: string; hint: string }[] = [
  { id: 'webhook', label: '自定义 Webhook', hint: 'URL / Method / Header / 字段名均可配置' },
  { id: 'serverchan', label: 'Server酱', hint: '填 SendKey，域名自动使用 sctapi.ftqq.com' },
  { id: 'pushplus', label: 'PushPlus', hint: '填 Token，域名自动使用 www.pushplus.plus' },
  { id: 'telegram', label: 'Telegram', hint: '填 Bot Token 与 Chat ID' },
];

const EVENT_META: { id: EventId; label: string; hint: string }[] = [
  { id: 'checkin_ok', label: '签到成功', hint: '每日签到全部成功时推送汇总' },
  { id: 'checkin_fail', label: '签到失败', hint: '存在失败账号时推送' },
  { id: 'credits_expiring', label: '积分临期', hint: '余额刷新后检测 3/7 天内过期积分' },
  { id: 'balance_low', label: '余额过低', hint: '账号余额低于 MIN_BALANCE_TO_USE 时提醒' },
  { id: 'refresh_fail', label: 'Token 刷新失败', hint: '预刷新或保活失败' },
  { id: 'pool_empty', label: '账号池空', hint: '池内无可用账号' },
  { id: 'growth_claimed', label: '成长奖励到账', hint: '成长中心领取/兑换/抽奖成功时推送' },
  { id: 'growth_departed', label: '派猫出发', hint: '成长中心派猫出游时推送' },
  { id: 'backup_done', label: '备份完成', hint: '全量备份成功完成后推送' },
  { id: 'backup_failed', label: '备份失败', hint: '全量备份失败时推送' },
];

const DEFAULT_EVENTS: NotifyEventPrefs = {
  checkin_ok: true,
  checkin_fail: true,
  credits_expiring: true,
  balance_low: true,
  refresh_fail: true,
  pool_empty: true,
  growth_claimed: true,
  growth_departed: true,
  backup_done: true,
  backup_failed: true,
};

/** 取字符串末 4 位作为可辨识片段；过短则整体用省略号替代 */
function tailOf(s: string): string {
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
}

/** 通知视图：通知渠道、提醒事件开关与自定义事件增删（备份已拆至 SettingsBackup）。 */
export default function SettingsNotify() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [notify, setNotify] = useState<NotifySettings>({});
  const [notifyStatus, setNotifyStatus] = useState<Status>({ msg: '', kind: '' });
  const [expandedChannel, setExpandedChannel] = useState<ChannelId | null>(null);
  const [customEvent, setCustomEvent] = useState('');
  const [eventsStatus, setEventsStatus] = useState<Status>({ msg: '', kind: '' });

  const loadNotify = useCallback(() => {
    if (!key) {
      setNotify({ events: { ...DEFAULT_EVENTS } });
      setNotifyStatus({ msg: '保存访问密钥后可配置通知渠道', kind: '' });
      return;
    }
    getNotifySettings(key)
      .then((d) => setNotify({ ...d, events: { ...DEFAULT_EVENTS, ...(d.events || {}) } }))
      .catch((e: Error) => setNotifyStatus({ msg: `通知配置加载失败：${e.message}`, kind: 'err' }));
  }, [key]);

  useEffect(() => {
    loadNotify();
  }, [loadNotify]);

  async function saveNotify() {
    try {
      await saveNotifySettings(notify, key);
      setNotifyStatus({ msg: '通知配置已保存，立即生效', kind: 'ok' });
      toast('通知配置已保存', 'ok');
    } catch (e) {
      setNotifyStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  function setEventEnabled(id: EventId, on: boolean) {
    setNotify((prev) => ({
      ...prev,
      events: { ...(prev.events || DEFAULT_EVENTS), [id]: on },
    }));
  }

  async function doTestNotify() {
    if (!key) {
      setNotifyStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    try {
      const r = await testNotify(key);
      if (r.ok) {
        setNotifyStatus({ msg: '测试通知已发送', kind: 'ok' });
        toast('测试通知已发送', 'ok');
      } else if (!r.enabled) {
        setNotifyStatus({ msg: '未配置通知渠道，请先填写并保存', kind: 'err' });
      } else {
        const parts = (r.results || []).map((c) =>
          c.ok ? `${c.channel} 已送达` : `${c.channel} 失败${c.message ? `（${c.message}）` : ''}`,
        );
        setNotifyStatus({ msg: `测试结果：${parts.join(' · ')}`, kind: 'err' });
        toast('测试通知未全部送达', 'err');
      }
    } catch (e) {
      setNotifyStatus({ msg: `测试失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  const notifyEventsData = (notify.events || {}) as Record<string, boolean>;
  const customEventIds = Object.keys(notifyEventsData).filter((id) => !EVENT_META.some((m) => m.id === id));

  async function addCustomEvent() {
    const id = customEvent.trim();
    if (!id) {
      setEventsStatus({ msg: '请输入事件名', kind: 'err' });
      return;
    }
    try {
      const r = await addNotifyEvent(id, key);
      setEventsStatus({ msg: `事件「${r.event.id}」已添加`, kind: 'ok' });
      toast(`事件「${r.event.id}」已添加`, 'ok');
      setCustomEvent('');
      loadNotify();
    } catch (e) {
      setEventsStatus({ msg: `添加失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function removeCustomEvent(id: string) {
    const ok = await prompt({ title: '删除自定义事件', message: `确定删除事件「${id}」？之后该事件将不再推送。`, danger: true, okText: '删除', cancelText: '取消' });
    if (!ok) return;
    try {
      await removeNotifyEvent(id, key);
      setEventsStatus({ msg: `事件「${id}」已删除`, kind: 'ok' });
      toast(`事件「${id}」已删除`, 'ok');
      loadNotify();
    } catch (e) {
      setEventsStatus({ msg: `删除失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  const isChannelConfigured = (id: ChannelId): boolean => {
    switch (id) {
      case 'webhook': return !!notify.webhookUrl?.trim();
      case 'serverchan': return !!notify.serverChanSendKey?.trim();
      case 'pushplus': return !!notify.pushPlusToken?.trim();
      case 'telegram': return !!notify.telegramBotToken?.trim() && !!notify.telegramChatId?.trim();
    }
  };

  const channelSummary = (id: ChannelId): string => {
    switch (id) {
      case 'webhook': {
        const url = notify.webhookUrl?.trim();
        if (!url) return '';
        // 数据源本身返回明文，摘要只露 host 与路径尾部，兼顾脱敏与可辨识
        try {
          const u = new URL(url);
          return `${u.host} ${tailOf(u.pathname)}`;
        } catch {
          return tailOf(url);
        }
      }
      case 'serverchan': return notify.serverChanSendKey?.trim() ? `SCT…${notify.serverChanSendKey!.slice(-4)}` : '';
      case 'pushplus': return notify.pushPlusToken?.trim() ? `Token…${notify.pushPlusToken!.slice(-4)}` : '';
      case 'telegram': return notify.telegramChatId?.trim() ? `…${notify.telegramChatId!.slice(-4)}` : '';
    }
  };

  const toggleChannel = (id: ChannelId) => {
    setExpandedChannel((cur) => (cur === id ? null : id));
  };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">通知渠道</h2>
        <p className="text-xs text-ink-soft mb-4">点击渠道展开配置，保存后立即生效；留空的渠道回退读取 .env 同名配置。下方可按事件类型开关推送。</p>

        <div className="border border-line-hairline rounded-card divide-y divide-line-hairline overflow-hidden">
          {CHANNEL_META.map((ch) => {
            const configured = isChannelConfigured(ch.id);
            const expanded = expandedChannel === ch.id;
            return (
              <div key={ch.id}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surf-soft transition-colors"
                  onClick={() => toggleChannel(ch.id)}
                  aria-expanded={expanded}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`inline-block w-2 h-2 rounded-full shrink-0 ${configured ? 'bg-acc' : 'bg-line'}`}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{ch.label}</div>
                      <div className="text-xs text-ink-faint truncate">
                        {configured ? channelSummary(ch.id) : ch.hint}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <span className={`text-xs ${configured ? 'text-acc-hover' : 'text-ink-faint'}`}>
                      {configured ? '已配置' : '未配置'}
                    </span>
                    <span className={`text-ink-faint text-xs transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden>
                      ▼
                    </span>
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 pt-1 border-t border-line-hairline bg-surf-soft/40">
                    {ch.id === 'webhook' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                        <div className="col-span-2">
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook">请求地址</label>
                          <input id="n-webhook" className="field w-full" value={notify.webhookUrl || ''} onChange={(e) => setNotify({ ...notify, webhookUrl: e.target.value })} placeholder="https://example.com/hook" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-method">请求方法</label>
                          <select id="n-webhook-method" className="field w-full" value={notify.webhookMethod || 'POST'} onChange={(e) => setNotify({ ...notify, webhookMethod: e.target.value })}>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-title-key">标题字段名</label>
                          <input id="n-webhook-title-key" className="field w-full" value={notify.webhookTitleKey || ''} onChange={(e) => setNotify({ ...notify, webhookTitleKey: e.target.value })} placeholder="title（留空则发 event/ts/text/payload）" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-content-key">内容字段名</label>
                          <input id="n-webhook-content-key" className="field w-full" value={notify.webhookContentKey || ''} onChange={(e) => setNotify({ ...notify, webhookContentKey: e.target.value })} placeholder="content（与标题字段名配合）" />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-headers">自定义 Header（JSON）</label>
                          <input id="n-webhook-headers" className="field w-full font-mono text-xs" value={notify.webhookHeaders || ''} onChange={(e) => setNotify({ ...notify, webhookHeaders: e.target.value })} placeholder='{"Authorization":"Bearer xxx"}' />
                          <p className="text-xs text-ink-faint mt-1">留空则仅发 Content-Type: application/json。填 JSON 可加 Authorization 等自定义头。</p>
                        </div>
                      </div>
                    )}
                    {ch.id === 'serverchan' && (
                      <div className="pt-3">
                        <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-serverchan">SendKey</label>
                        <input id="n-serverchan" className="field w-full" value={notify.serverChanSendKey || ''} onChange={(e) => setNotify({ ...notify, serverChanSendKey: e.target.value })} placeholder="SCT…（sct.ftqq.com）" />
                      </div>
                    )}
                    {ch.id === 'pushplus' && (
                      <div className="pt-3">
                        <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-pushplus">Token</label>
                        <input id="n-pushplus" className="field w-full" value={notify.pushPlusToken || ''} onChange={(e) => setNotify({ ...notify, pushPlusToken: e.target.value })} placeholder="www.pushplus.plus" />
                      </div>
                    )}
                    {ch.id === 'telegram' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                        <div>
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-tg-token">Bot Token</label>
                          <input id="n-tg-token" className="field w-full" value={notify.telegramBotToken || ''} onChange={(e) => setNotify({ ...notify, telegramBotToken: e.target.value })} placeholder="123456:ABC…" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-tg-chat">Chat ID</label>
                          <input id="n-tg-chat" className="field w-full" value={notify.telegramChatId || ''} onChange={(e) => setNotify({ ...notify, telegramChatId: e.target.value })} placeholder="chat_id" />
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2 mt-3">
                      <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
                        保存通知配置
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={doTestNotify}>
                        测试通知
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-ink-soft">提醒事件</h3>
            <span className="text-[11px] text-ink-faint">关闭后该类事件不再推送（渠道需已配置）</span>
          </div>
          <div className="border border-line-hairline rounded-card divide-y divide-line-hairline overflow-hidden">
            {EVENT_META.map((ev) => {
              const on = notify.events?.[ev.id] !== false;
              return (
                <label
                  key={ev.id}
                  htmlFor={`ev-${ev.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer hover:bg-surf-soft transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-ink">{ev.label}</div>
                    <div className="text-xs text-ink-faint truncate">{ev.hint}</div>
                  </div>
                  <input
                    id={`ev-${ev.id}`}
                    type="checkbox"
                    className="w-4 h-4 accent-acc shrink-0"
                    checked={on}
                    onChange={(e) => setEventEnabled(ev.id, e.target.checked)}
                  />
                </label>
              );
            })}
          </div>
          <div className="flex gap-2 mt-3">
            <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
              保存通知配置
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={doTestNotify}>
              测试通知
            </button>
          </div>
        </div>

        {notifyStatus.msg && (
          <div role="status" className={`text-xs mt-2.5 ${notifyStatus.kind === 'ok' ? 'text-acc-hover' : notifyStatus.kind === 'err' ? 'text-danger' : 'text-ink-soft'}`}>
            {notifyStatus.msg}
          </div>
        )}
      </div>

      <SettingsBackup />

      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">通知事件（增 / 删）</h2>
        <p className="text-xs text-ink-soft mb-4">
          内置事件可在上方「提醒事件」开关；此处可新增自定义事件名（推送时按该事件名发送、可在此开关），或删除已添加的自定义事件。内置事件不可删除、只能关闭。
        </p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存访问密钥后可管理通知事件</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 items-center mb-3">
              <input
                className="field flex-1 min-w-[220px] font-mono text-xs"
                value={customEvent}
                onChange={(e) => setCustomEvent(e.target.value)}
                placeholder="事件名（小写字母/数字/下划线，如 quota_low）"
              />
              <button type="button" className="btn btn-primary" onClick={addCustomEvent}>
                添加事件
              </button>
            </div>
            {customEventIds.length > 0 && (
              <div className="border border-line-hairline rounded-card divide-y divide-line-hairline overflow-hidden mb-3">
                {customEventIds.map((id) => (
                  <div key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-[12px] text-ink truncate">{id}</span>
                      <span className="text-[10px] text-ink-faint shrink-0">自定义</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-acc"
                          checked={notifyEventsData[id] !== false}
                          onChange={(e) => setEventEnabled(id as EventId, e.target.checked)}
                        />
                        启用
                      </label>
                      <button type="button" className="btn-quiet text-danger" onClick={() => removeCustomEvent(id)}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {eventsStatus.msg && (
              <div role="status" className={`text-xs mt-2 ${eventsStatus.kind === 'ok' ? 'text-acc-hover' : eventsStatus.kind === 'err' ? 'text-danger' : ''}`}>
                {eventsStatus.msg}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
                保存事件开关
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}