/**
 * 通知与备份面板。
 *
 * 两块内容都直接落在后端真实能力上，不在前端推断业务状态：
 *   - 通知：总开关 + 四类渠道凭据 + 事件开关，由 /v1/admin/notify/settings 读写。
 *     「是否真的会发送」取后端 running / activeChannels 字段。
 *   - 备份：定时配置、立即备份、校验、内容预览与恢复，由 /v1/admin/backup/* 提供。
 *     恢复是覆盖写，因此默认先做一次安全快照，并在确认弹窗中说明影响。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  NOTIFY_CHANNEL_LABELS,
  NOTIFY_EVENT_LABELS,
  getBackup,
  getNotifySettings,
  inspectBackup,
  restoreBackup,
  runBackup,
  saveBackup,
  saveNotifySettings,
  testNotify,
  verifyBackup,
  type BackupInspect,
  type NotifySettings,
} from '../../shared/api/admin';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import {
  Button,
  Chip,
  ErrorState,
  Field,
  LoadingBlock,
  Panel,
  Segmented,
} from '../../shared/ui';
import { usePrompt } from '../../shared/ui/Prompt';
import { useToast } from '../../shared/ui/Toast';

/** 渠道字段定义。id 与后端 notify/settings.js 的 FIELDS 一致。 */
const CHANNELS: {
  id: keyof NotifySettings;
  channel: string;
  label: string;
  placeholder: string;
  /** 密钥类字段：已配置时用掩码提示，避免明文占位 */
  secret: boolean;
  hint?: string;
}[] = [
  {
    id: 'webhookUrl',
    channel: 'webhook',
    label: 'Webhook 地址',
    placeholder: 'https://example.com/hook',
    secret: false,
  },
  {
    id: 'webhookMethod',
    channel: 'webhook',
    label: '请求方法',
    placeholder: 'POST',
    secret: false,
    hint: '留空按 POST',
  },
  {
    id: 'webhookHeaders',
    channel: 'webhook',
    label: '请求头',
    placeholder: '{"Authorization":"Bearer …"}',
    secret: true,
    hint: 'JSON 字符串',
  },
  {
    id: 'webhookTitleKey',
    channel: 'webhook',
    label: '标题字段',
    placeholder: 'title',
    secret: false,
  },
  {
    id: 'webhookContentKey',
    channel: 'webhook',
    label: '内容字段',
    placeholder: 'content',
    secret: false,
  },
  {
    id: 'serverChanSendKey',
    channel: 'serverchan',
    label: 'SendKey',
    placeholder: 'SCT…',
    secret: true,
  },
  {
    id: 'pushPlusToken',
    channel: 'pushplus',
    label: 'Token',
    placeholder: '…',
    secret: true,
  },
  {
    id: 'telegramBotToken',
    channel: 'telegram',
    label: 'Bot Token',
    placeholder: '123456:ABC…',
    secret: true,
  },
  {
    id: 'telegramChatId',
    channel: 'telegram',
    label: 'Chat ID',
    placeholder: '-100…',
    secret: false,
    hint: '与 Bot Token 同时配置才生效',
  },
];

const CHANNEL_IDS = ['webhook', 'serverchan', 'pushplus', 'telegram'] as const;

/** 表单字段全集，草稿与提交体共用，避免两处维护。 */
const FORM_FIELDS: (keyof NotifySettings)[] = CHANNELS.map((c) => c.id);

function draftOf(src: NotifySettings | undefined): NotifySettings {
  const out: Record<string, string> = {};
  for (const f of FORM_FIELDS) {
    const v = src?.[f];
    out[f] = typeof v === 'string' ? v : '';
  }
  return { enabled: src?.enabled !== false, ...out } as NotifySettings;
}

/** 掩码提示：仅告知「已配置」，不回显明文。 */
function maskHint(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  return v.length <= 10 ? '已配置' : `已配置 ${v.slice(0, 3)}…${v.slice(-2)}`;
}

/** 字节数转可读文本。 */
function formatSize(v: number | undefined): string {
  if (v == null) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function NotifyBackupPanel({ apiKey }: { apiKey: string }) {
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotifySettings>({});
  const [dirty, setDirty] = useState(false);
  const [inspect, setInspect] = useState<BackupInspect | null>(null);
  const [keepDraft, setKeepDraft] = useState({ keep: 5, intervalHours: 24 });

  const notify = useAsyncData((signal) => getNotifySettings(apiKey, signal), [apiKey], {
    enabled: !!apiKey,
  });
  const backup = useAsyncData((signal) => getBackup(apiKey, signal), [apiKey], {
    enabled: !!apiKey,
  });

  // 载入后重置草稿；用户编辑中不覆盖，避免输入被回填冲掉
  useEffect(() => {
    if (!notify.data || dirty) return;
    setDraft(draftOf(notify.data));
  }, [notify.data, dirty]);

  useEffect(() => {
    if (!backup.data) return;
    setKeepDraft({
      keep: backup.data.keep ?? 5,
      intervalHours: backup.data.intervalHours ?? 24,
    });
  }, [backup.data]);

  const channelRows = useMemo(() => {
    const configured = new Set(notify.data?.configuredChannels ?? []);
    const active = new Set(notify.data?.activeChannels ?? []);
    return CHANNEL_IDS.map((id) => {
      const fields = CHANNELS.filter((c) => c.channel === id);
      return {
        id,
        label: NOTIFY_CHANNEL_LABELS[id],
        fields,
        active: active.has(id),
        // Webhook 只看地址；Telegram 需要两字段齐备，与后端判定一致
        configured: configured.has(id),
      };
    });
  }, [notify.data]);

  const events = useMemo(() => {
    const map = notify.data?.events ?? {};
    return Object.entries(NOTIFY_EVENT_LABELS).map(([id, label]) => ({
      id,
      label,
      enabled: map[id] !== false,
    }));
  }, [notify.data]);

  async function saveNotify(patch: Partial<NotifySettings> = {}) {
    setBusy('notify');
    try {
      const next = await saveNotifySettings({ ...draft, ...patch }, apiKey);
      setDraft(draftOf(next));
      setDirty(false);
      notify.reload();
      toast('通知设置已保存', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doTestNotify() {
    setBusy('notify-test');
    try {
      const r = await testNotify(apiKey);
      const results = r.results ?? [];
      if (!results.length) {
        toast(r.enabled ? '已发送，但没有渠道回执' : '没有可用渠道，未发送', r.enabled ? 'warn' : 'err');
        return;
      }
      const failed = results.filter((x) => !x.ok);
      if (failed.length) {
        toast(
          `${failed.length}/${results.length} 个渠道失败：${failed
            .map((x) => `${NOTIFY_CHANNEL_LABELS[x.channel] ?? x.channel} ${x.error ?? '未知原因'}`)
            .join('；')}`,
          'err',
        );
      } else {
        toast(`${results.length} 个渠道均已送达`, 'ok');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '测试失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doRunBackup() {
    setBusy('backup-run');
    try {
      const r = await runBackup(apiKey);
      if (r.ok) {
        toast(`备份完成：${r.file ?? ''}`, 'ok');
      } else if (r.running) {
        toast('备份正在执行中', 'warn');
      } else {
        toast(`备份未成功：${r.error ?? '后端未给出原因'}`, 'err');
      }
      backup.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '备份失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function saveBackupSettings(patch: Parameters<typeof saveBackup>[0]) {
    setBusy('backup-settings');
    try {
      const next = await saveBackup(patch, apiKey);
      backup.reload();
      setKeepDraft({
        keep: next.keep ?? keepDraft.keep,
        intervalHours: next.intervalHours ?? keepDraft.intervalHours,
      });
      toast('备份设置已保存', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存备份设置失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doVerify(path: string, file: string) {
    setBusy(`verify-${path}`);
    try {
      const r = await verifyBackup(path, apiKey);
      if (r.ok) toast(`校验通过：${file}`, 'ok');
      else toast(`校验未通过：${r.reason ?? '后端未给出原因'}`, 'err');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '校验失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doInspect(path: string) {
    setBusy(`inspect-${path}`);
    setInspect(null);
    try {
      setInspect(await inspectBackup(path, apiKey));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取备份内容失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doRestore(path: string, file: string) {
    const ok = await prompt({
      title: '从该备份恢复？',
      message: `将用 ${file} 覆盖同 id 的账号、密钥与配置。恢复前会自动生成一份当前状态快照。`,
      okText: '恢复',
      danger: true,
    });
    if (ok !== true) return;
    setBusy(`restore-${path}`);
    try {
      const r = await restoreBackup(path, apiKey, true);
      toast(
        `恢复完成：账号 ${r.accounts}，密钥 ${r.apiKeys}，配置 ${r.configs}${
          r.safetyBackupFile ? `；安全快照 ${r.safetyBackupFile}` : ''
        }`,
        'ok',
      );
      setInspect(null);
      backup.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '恢复失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Panel
        title="通知"
        description="总开关关闭时，即使配好渠道也不会发送"
        actions={
          <>
            <Button size="sm" onClick={doTestNotify} disabled={busy === 'notify-test'}>
              {busy === 'notify-test' ? '发送中…' : '发送测试'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => saveNotify()}
              disabled={busy === 'notify' || !dirty}
            >
              {busy === 'notify' ? '保存中…' : '保存'}
            </Button>
          </>
        }
        footer="凭据保存在服务端本机配置文件。密钥类字段不会明文回显，已配置时输入框显示掩码提示。"
      >
        {notify.loading && !notify.data ? (
          <LoadingBlock />
        ) : notify.error ? (
          <ErrorState message={notify.error} onRetry={notify.reload} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Segmented
                ariaLabel="通知总开关"
                value={draft.enabled === false ? 'off' : 'on'}
                onChange={(v) => {
                  setDraft((d) => ({ ...d, enabled: v === 'on' }));
                  setDirty(true);
                }}
                options={[
                  { value: 'on', label: '启用' },
                  { value: 'off', label: '停用' },
                ]}
              />
              {notify.data?.running ? (
                <Chip tone="ok" dot="dot-ok">
                  发送中 · {notify.data.activeChannels?.length ?? 0} 个渠道
                </Chip>
              ) : notify.data?.configuredChannels?.length ? (
                <Chip tone="warn" dot="dot-cool">
                  已配 {notify.data.configuredChannels.length} 个渠道，当前不发送
                </Chip>
              ) : (
                <Chip tone="neutral" dot="dot-off">
                  未配置任何渠道
                </Chip>
              )}
            </div>

            <div className="grid gap-4 grid-cols-2 items-start">
              {channelRows.map((ch) => (
                <div
                  key={ch.id}
                  className="rounded-lg border px-3.5 py-3 min-w-0"
                  style={{ borderColor: 'var(--rg-border)' }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                      {ch.label}
                    </span>
                    <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                    <Chip tone={ch.active ? 'ok' : 'neutral'} dot={ch.active ? 'dot-ok' : 'dot-off'}>
                      {ch.active ? '生效中' : '未生效'}
                    </Chip>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {ch.fields.map((f) => (
                      <Field
                        key={String(f.id)}
                        label={f.hint ? `${f.label}（${f.hint}）` : f.label}
                        className="font-mono text-[12px]"
                        value={String(draft[f.id] ?? '')}
                        placeholder={
                          f.secret && maskHint(notify.data?.[f.id])
                            ? maskHint(notify.data?.[f.id])
                            : f.placeholder
                        }
                        onChange={(e) => {
                          setDraft((d) => ({ ...d, [f.id]: e.target.value }));
                          setDirty(true);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div className="text-aux font-medium mb-2" style={{ color: 'var(--rg-text-secondary)' }}>
                事件开关
              </div>
              <div className="grid gap-2 grid-cols-3">
                {events.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    aria-pressed={ev.enabled}
                    disabled={busy === 'notify'}
                    className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[12px] cursor-pointer transition-colors disabled:opacity-60"
                    style={{
                      borderColor: ev.enabled ? 'var(--rg-border-strong)' : 'var(--rg-border)',
                      background: ev.enabled ? 'var(--rg-brand-50)' : 'transparent',
                      color: ev.enabled ? 'var(--rg-brand-700)' : 'var(--rg-text-tertiary)',
                    }}
                    onClick={() => saveNotify({ events: { ...(notify.data?.events ?? {}), [ev.id]: !ev.enabled } })}
                  >
                    <span className="truncate">{ev.label}</span>
                    <span className="shrink-0">{ev.enabled ? '开启' : '关闭'}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="备份"
        description="备份为加密单文件，恢复会覆盖同 id 数据"
        actions={
          <Button size="sm" variant="primary" onClick={doRunBackup} disabled={busy === 'backup-run'}>
            {busy === 'backup-run' ? '执行中…' : '立即备份'}
          </Button>
        }
        footer="备份内容经 AES-256-GCM 加密，密钥来自服务端环境变量或本机密钥文件；换机器恢复需要同一把密钥。"
      >
        {backup.loading && !backup.data ? (
          <LoadingBlock />
        ) : backup.error ? (
          <ErrorState message={backup.error} onRetry={backup.reload} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-4 grid-cols-2 items-start">
              <div
                className="rounded-lg border px-3.5 py-3 min-w-0"
                style={{ borderColor: 'var(--rg-border)' }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                    定时备份
                  </span>
                  <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                  <Chip
                    tone={backup.data?.enabled ? 'ok' : 'neutral'}
                    dot={backup.data?.enabled ? 'dot-ok' : 'dot-off'}
                  >
                    {backup.data?.enabled ? '已开启' : '已关闭'}
                  </Chip>
                </div>
                <div className="flex flex-col gap-2.5">
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                      启用定时备份
                    </span>
                    <input
                      type="checkbox"
                      checked={backup.data?.enabled === true}
                      disabled={busy === 'backup-settings'}
                      onChange={(e) => saveBackupSettings({ enabled: e.target.checked })}
                    />
                  </label>
                  <Field
                    label="间隔（小时）"
                    type="number"
                    className="font-mono text-[12px]"
                    min={1}
                    max={168}
                    value={String(keepDraft.intervalHours)}
                    onChange={(e) => setKeepDraft((d) => ({ ...d, intervalHours: Number(e.target.value) }))}
                  />
                  <Field
                    label="保留份数"
                    type="number"
                    className="font-mono text-[12px]"
                    min={1}
                    max={50}
                    value={String(keepDraft.keep)}
                    onChange={(e) => setKeepDraft((d) => ({ ...d, keep: Number(e.target.value) }))}
                  />
                  <Button
                    size="sm"
                    disabled={
                      busy === 'backup-settings' ||
                      (keepDraft.keep === backup.data?.keep &&
                        keepDraft.intervalHours === backup.data?.intervalHours)
                    }
                    onClick={() => saveBackupSettings({ keep: keepDraft.keep, intervalHours: keepDraft.intervalHours })}
                  >
                    {busy === 'backup-settings' ? '保存中…' : '保存定时设置'}
                  </Button>
                  <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {backup.data?.timer?.nextRunAt
                      ? `下次运行：${backup.data.timer.nextRunAt}`
                      : '定时任务未启动'}
                  </div>
                </div>
              </div>

              <div
                className="rounded-lg border px-3.5 py-3 min-w-0"
                style={{ borderColor: 'var(--rg-border)' }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                    最近一次
                  </span>
                  <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                </div>
                <dl className="flex flex-col text-[13px]">
                  {[
                    { k: '时间', v: backup.data?.lastBackupAt || '—', mono: true },
                    {
                      k: '结果',
                      v:
                        backup.data?.lastBackupOk === true ? (
                          <Chip tone="ok" dot="dot-ok">成功</Chip>
                        ) : backup.data?.lastBackupOk === false ? (
                          <Chip tone="danger" dot="dot-error">失败</Chip>
                        ) : (
                          <Chip tone="neutral" dot="dot-off">暂无</Chip>
                        ),
                    },
                    { k: '文件', v: backup.data?.lastBackupFile || '—', mono: true },
                    { k: '目录', v: backup.data?.dir || '—', mono: true },
                  ].map((row) => (
                    <div
                      key={row.k}
                      className="grid gap-2 py-[5px] items-baseline"
                      style={{ gridTemplateColumns: '64px minmax(0, 1fr)' }}
                    >
                      <dt className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {row.k}
                      </dt>
                      <dd
                        className={`m-0 text-[12px] break-all ${row.mono ? 'font-mono' : ''}`}
                      >
                        {row.v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--rg-border)' }}>
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">文件</th>
                    <th className="th cell-num">大小</th>
                    <th className="th">创建时间</th>
                    <th className="th cell-act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(backup.data?.list ?? []).length === 0 ? (
                    <tr>
                      <td className="td" colSpan={4} style={{ color: 'var(--rg-text-tertiary)' }}>
                        暂无备份文件
                      </td>
                    </tr>
                  ) : (
                    (backup.data?.list ?? []).map((b) => {
                      const target = b.path ?? '';
                      return (
                        <tr key={b.file} className="row-hover">
                          <td className="td font-mono text-[12px] break-all">{b.file}</td>
                          <td className="td cell-num">{formatSize(b.sizeBytes)}</td>
                          <td className="td font-mono text-[12px]">{b.createdAt || '—'}</td>
                          <td className="td cell-act">
                            <div className="flex items-center gap-1.5 justify-end">
                              <Button
                                size="sm"
                                disabled={!target || busy === `verify-${target}`}
                                onClick={() => doVerify(target, b.file)}
                              >
                                校验
                              </Button>
                              <Button
                                size="sm"
                                disabled={!target || busy === `inspect-${target}`}
                                onClick={() => doInspect(target)}
                              >
                                内容
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={!target || busy === `restore-${target}`}
                                onClick={() => doRestore(target, b.file)}
                              >
                                恢复
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {inspect && (
              <div className="rounded-lg border px-3.5 py-3" style={{ borderColor: 'var(--rg-border)' }}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                    {inspect.file} 内容
                  </span>
                  <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                  <Button size="sm" variant="ghost" onClick={() => setInspect(null)}>
                    关闭
                  </Button>
                </div>
                <dl className="flex flex-col text-[13px]">
                  <div className="grid gap-2 py-[5px] items-baseline" style={{ gridTemplateColumns: '64px minmax(0, 1fr)' }}>
                    <dt className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>校验</dt>
                    <dd className="m-0">
                      <Chip tone={inspect.checksumOk ? 'ok' : 'danger'} dot={inspect.checksumOk ? 'dot-ok' : 'dot-error'}>
                        {inspect.checksumReason ?? (inspect.checksumOk ? '校验和一致' : '校验未通过')}
                      </Chip>
                    </dd>
                  </div>
                  {[
                    { k: '账号', v: inspect.summary.accounts },
                    { k: '密钥', v: inspect.summary.apiKeys },
                    { k: '积分记录', v: inspect.summary.creditHistory },
                    { k: '配置文件', v: inspect.summary.configKeys },
                    { k: '通知设置', v: inspect.summary.hasNotifySettings ? '含' : '不含' },
                    { k: '余额刷新', v: inspect.summary.hasBalanceRefresh ? '含' : '不含' },
                  ].map((row) => (
                    <div
                      key={row.k}
                      className="grid gap-2 py-[5px] items-baseline"
                      style={{ gridTemplateColumns: '64px minmax(0, 1fr)' }}
                    >
                      <dt className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>{row.k}</dt>
                      <dd className="m-0 font-mono text-[12px]">{row.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}