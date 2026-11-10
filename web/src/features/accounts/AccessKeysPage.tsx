/**
 * 访问密钥页：创建、轮换、吊销、重置与一次性明文查看。
 * 后端语义：明文 key 仅在创建、轮换、重置、reveal 时返回一次，列表接口只返回掩码。
 * 页面据此设计：列表恒用掩码，明文只出现在「最近生成」区域，避免长期暴露在屏幕上。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setKey, useAuth } from '../../shared/api/auth';
import { getClientConfig } from '../../shared/api/admin';
import {
  deleteAccessKey,
  isKeyUsable,
  keyDaysLeft,
  listAccessKeys,
  listLoginKeys,
  maskKey,
  resetAccessKey,
  resetLoginKey,
  revokeAccessKey,
  revealAccessKey,
  rotateAccessKey,
  type ApiKeyRow,
  type CreatedKey,
} from '../../shared/api/apiKeys';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Note,
  Panel,
  Segmented,
} from '../../shared/ui';
import { MenuButton, type MenuItem } from '../../shared/ui/Menu';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';
import { LoginKeyDialog } from './LoginKeyDialog';
import { CreateAccessKeyDialog } from './CreateAccessKeyDialog';
import { KeyPolicyDialog } from './KeyPolicyDialog';
import { ClientAccessPanel } from '../ops/ClientAccessPanel';

type Filter = 'all' | 'active' | 'revoked';

/** 后端 status 字段的中文文案。 */
const STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  disabled: '已停用',
  revoked: '已吊销',
  expired: '已过期',
};

/** 未知 status 的最后手段映射，避免映射缺失导致渲染中断。 */
function statusLabel(status: string | undefined): string {
  return STATUS_LABEL[status ?? 'active'] ?? status ?? '生效中';
}

/**
 * 密钥明文块。访问密钥与登录密钥两处展示完全一致，此前逐字复制过两份。
 * select-all 让用户点一次就能整段选中，复制按钮失败时仍有手动兜底。
 */
function SecretBox({ value }: { value: string }) {
  return (
    <div className="code-block select-all text-[13px]">{value}</div>
  );
}

export default function AccessKeysPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<Filter>('all');
  const [fresh, setFresh] = useState<CreatedKey | null>(null);
  // 登录密钥明文单独展示：不附带「客户端接入」面板（那是访问密钥的 IDE 配置指引）
  const [loginFresh, setLoginFresh] = useState<CreatedKey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showLoginInput, setShowLoginInput] = useState(false);
  /** 创建访问密钥弹窗（需要平台选择，prompt 承载不了）。 */
  const [creating, setCreating] = useState(false);

  const list = useAsyncData((signal) => listAccessKeys(key, signal), [key], { enabled: !!key });
  // 登录密钥接口返回 { object, data }，是否已配置由列表长度判断
  const loginKeys = useAsyncData((signal) => listLoginKeys(key, signal), [key], { enabled: !!key });
  // 取得明文密钥后同时展示接入配置，省去用户到运维页第 5 分段查找
  const clientConfig = useAsyncData((signal) => getClientConfig(key, signal), [key], {
    enabled: !!key,
  });

  const rows = useMemo(() => {
    const all = list.data?.data ?? [];
    if (filter === 'all') return all;
    return filter === 'active' ? all.filter(isKeyUsable) : all.filter((r) => !isKeyUsable(r));
  }, [list.data, filter]);

  /** 已配置的登录密钥（后端可能存在多条，取最新一条）。 */
  const loginKeyRow = loginKeys.data?.data?.[0] ?? null;

  /** 正在编辑权限与配额的密钥；null = 关闭。 */
  const [policyTarget, setPolicyTarget] = useState<ApiKeyRow | null>(null);

  /** 明文只在此处短暂展示，切换页面前应清空。 */
  function revealFresh(c: CreatedKey | null) {
    setFresh(c);
  }

  async function run(id: string, label: string, fn: () => Promise<unknown>, msg: string) {
    setBusyId(id);
    try {
      await fn();
      toast(msg, 'ok');
      list.reload();
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : `${label}失败`, 'err');
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function create() {
    // 平台选择改到专用弹窗（CreateAccessKeyDialog）：usePrompt 只支持单个文本
    // 输入框，此前 platform 被硬编码成 'all'，用户无法创建 Trae / WorkBuddy
    // 专用密钥 —— 那把「收窄密钥权限」的唯一入口也就没有了。
    setCreating(true);
  }

  async function rotate(id: string) {
    const ok = await prompt({
      title: '轮换该密钥？',
      message: '将生成一把新密钥；旧密钥保留 24 小时宽限期后自动失效。',
      okText: '轮换',
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(id);
    try {
      // 24h 与后端 rotateKey 默认值一致：宽限期让调用方有时间替换配置
      const created = await rotateAccessKey(id, 24 * 3600_000, key);
      revealFresh(created);
      toast('已轮换，新明文如下', 'ok');
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '轮换失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function reset(id: string) {
    const ok = await prompt({
      title: '重置该密钥？',
      message: '重置会生成新的明文，旧密钥立即失效；当前会话会自动切到新密钥，不会被退出。',
      okText: '重置',
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(id);
    try {
      const created = await resetAccessKey(id, key);
      revealFresh(created);
      toast('已重置，新明文如下', 'ok');
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '重置失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(id: string) {
    const ok = await prompt({ title: '吊销该密钥？', message: '吊销后调用将立即失败。', okText: '吊销', danger: true });
    if (ok !== true) return;
    await run(id, '吊销', () => revokeAccessKey(id, key), '已吊销');
  }

  async function reveal(id: string) {
    setBusyId(id);
    try {
      const r = await revealAccessKey(id, key);
      revealFresh({ id: r.id, key: r.key });
      toast('已显示明文', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取明文失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: ApiKeyRow) {
    const name = row.label || maskKey(row.id);
    const ok = await prompt({
      title: `删除访问密钥「${name}」？`,
      message: '删除后该密钥立即失效且无法恢复，调用方会收到 401。',
      okText: '删除',
      danger: true,
    });
    if (ok !== true) return;
    await run(row.id, '删除', () => deleteAccessKey(row.id, key), '已删除');
  }

  async function copyPlaintext() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.key);
      toast('已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  }

  async function copyLoginPlaintext() {
    if (!loginFresh) return;
    try {
      await navigator.clipboard.writeText(loginFresh.key);
      toast('已复制', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  }

  /**
   * 取回当前登录密钥的明文（后端 key_enc 有密文备份）。
   * 覆盖「已配置但手头没明文」的场景，避免只能再重置一次。
   */
  async function revealLoginKey() {
    const id = loginKeyRow?.id;
    if (!id) {
      toast('尚未配置登录密钥', 'err');
      return;
    }
    setBusyId('__reveal_login__');
    try {
      const r = await revealAccessKey(id, key);
      setLoginFresh({ id: r.id, key: r.key, label: loginKeyRow?.label || undefined });
      toast('已显示登录密钥明文', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '读取明文失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageShell
      title="访问密钥"
      description="供 IDE 调用转发接口的密钥，与登录密钥分离"
      actions={
        <Button variant="primary" onClick={create} disabled={creating}>
          {creating ? '创建中…' : '创建密钥'}
        </Button>
      }
      toolbar={
        <>
          <Segmented
            ariaLabel="状态筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'active', label: '生效中' },
              { value: 'revoked', label: '停用 / 吊销 / 过期' },
            ]}
          />
          <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
            共 {rows.length} 个密钥
          </span>
        </>
      }
    >
      <Stack>
        {list.error && <ErrorState message={list.error} onRetry={list.reload} />}

        <Panel title="密钥列表" flush>
          {list.loading && !list.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <EmptyState
              label="还没有访问密钥"
              hint="IDE 或脚本要调用本网关，需要一把 sk- 开头的访问密钥；登录管理面板用的是另一把登录密钥，两者互不通用。"
              action={{ label: '创建第一把访问密钥', onClick: create }}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th">备注</th>
                  <th className="th">平台</th>
                  <th className="th">密钥</th>
                  <th className="th">权限与配额</th>
                  <th className="th">状态</th>
                  <th className="th">创建时间</th>
                  <th className="th">最近使用</th>
                  <th className="th cell-act">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const busy = busyId === r.id;
                  const usable = isKeyUsable(r);
                  const days = keyDaysLeft(r.expiresAt);
                  return (
                    <tr key={r.id} className="row-hover">
                      <td className="td td-mono">{r.label || '—'}</td>
                      <td className="td">{r.platform || 'all'}</td>
                      <td className="td td-mono">{r.hint || maskKey(r.id)}</td>
                      {/*
                        权限列：scopes / resources / rpm / 过期四件事压成一行。
                        后端 rowToKey 一直在下发这四项（credentials/api-keys.js），
                        面板此前一项都不渲染——用户拿到一把「全能钥匙」看不到它有多全能。
                      */}
                      <td className="td">
                        <button
                          type="button"
                          className="text-left w-full truncate text-[13px] underline decoration-dotted"
                          title={[
                            `权限范围：${(r.scopes ?? []).join('、') || '（平台默认）'}`,
                            `资源范围：${(r.resources ?? []).join('、') || '（平台默认）'}`,
                            `RPM 上限：${r.rpmLimit != null ? r.rpmLimit : '不限'}`,
                            `过期：${r.expiresAt ? formatTime(r.expiresAt) : '永不过期'}`,
                            '点击编辑',
                          ].join('\n')}
                          onClick={() => setPolicyTarget(r)}
                          aria-haspopup="dialog"
                        >
                          {(r.scopes ?? []).length} 项 ·{' '}
                          <span className="font-mono">{(r.resources ?? [])[0] ?? '*'}</span>
                          {(r.resources ?? []).length > 1 ? ` +${(r.resources ?? []).length - 1}` : ''}
                          {' · '}
                          {r.rpmLimit != null ? `${r.rpmLimit} rpm` : '不限速'}
                          {' · '}
                          <span
                            style={{
                              color:
                                days == null
                                  ? 'var(--rg-text-tertiary)'
                                  : days <= 0
                                    ? 'var(--rg-state-error)'
                                    : days <= 14
                                      ? 'var(--rg-state-warning)'
                                      : 'var(--rg-text-secondary)',
                            }}
                          >
                            {days == null ? '永久' : days <= 0 ? '已过期' : `${days} 天`}
                          </span>
                        </button>
                      </td>
                      <td className="td">
                        <Chip
                          tone={usable ? 'ok' : r.status === 'disabled' ? 'neutral' : 'danger'}
                          dot={usable ? 'dot-ok' : r.status === 'disabled' ? 'dot-off' : 'dot-error'}
                        >
                          {statusLabel(r.status)}
                        </Chip>
                      </td>
                      <td className="td td-mono">{formatTime(r.createdAt)}</td>
                      <td className="td td-mono">{formatTime(r.lastUsedAt)}</td>
                      <td className="td cell-act">
                        {/*
                          主次分层：两个最常用动作留在行内，其余进 ⋯ 菜单。
                          此前是 5 个 size="sm" 平铺，只有「删除」是 danger，
                          「吊销」和「查看明文」视觉权重完全相同——而前者是
                          不可恢复的破坏动作，后者是只读。
                        */}
                        <div className="td-actions">
                          <Button size="sm" disabled={busy || !usable} onClick={() => reveal(r.id)}>
                            查看
                          </Button>
                          <Button size="sm" disabled={busy || !usable} onClick={() => rotate(r.id)}>
                            轮换
                          </Button>
                          <MenuButton
                            label={`${r.label || maskKey(r.id)} 的更多操作`}
                            width={200}
                            items={[
                              {
                                key: 'policy',
                                label: '权限与配额',
                                hint: 'scopes / 资源范围 / RPM / 过期',
                                onSelect: () => setPolicyTarget(r),
                              },
                              {
                                key: 'reset',
                                label: '重置明文',
                                disabled: busy,
                                hint: '生成新明文，旧密钥立即失效',
                                onSelect: () => void reset(r.id),
                              },
                              {
                                key: 'revoke',
                                label: '吊销',
                                disabled: busy || !usable,
                                groupStart: true,
                                hint: '立即失效且不可恢复',
                                onSelect: () => void revoke(r.id),
                              },
                              {
                                key: 'del',
                                label: '删除',
                                danger: true,
                                disabled: busy,
                                hint: '从库内移除，调用方会收到 401',
                                onSelect: () => void remove(r),
                              },
                            ] as MenuItem[]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {fresh && (
          <Panel
            title="最近生成的明文"
            actions={
              <>
                <Button size="sm" onClick={copyPlaintext}>
                  复制
                </Button>
                <Button size="sm" variant="ghost" onClick={() => revealFresh(null)}>
                  关闭
                </Button>
              </>
            }
          >
            <SecretBox value={fresh.key} />
            <div className="mt-3">
              <Note>明文仅在创建、轮换、重置与查看时返回，关闭后无法再次获取。</Note>
            </div>
          </Panel>
        )}

        {/* 密钥本身不带服务地址，用户拿到明文后必须知道填什么。
            此前这份接入指引只在「运维 → 网关配置」的最后一个分段里，
            与 mint 密钥、验证连通性两页之间没有任何链接，形成三页断裂。 */}
        {fresh && (
          <>
            <ClientAccessPanel
              config={clientConfig.data}
              loading={clientConfig.loading && !clientConfig.data}
              error={clientConfig.error}
              onRetry={clientConfig.reload}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => navigate('/traffic')}>
                去验证连通性
              </Button>
              <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                在「请求日志 → 连通性测试」里发一次真实请求，确认这把密钥可用。
              </span>
            </div>
          </>
        )}

        {loginFresh && (
          <Panel
            title="登录密钥明文"
            description="当前会话已切换到该密钥，无需重新登录"
            actions={
              <>
                <Button size="sm" onClick={copyLoginPlaintext}>
                  复制
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setLoginFresh(null)}>
                  关闭
                </Button>
              </>
            }
          >
            <SecretBox value={loginFresh.key} />
            <div className="mt-3">
              <Note tone="warn">
                请立即复制并妥善保存。明文只在这里显示一次，关闭后列表仅保留掩码
                （必要时可用「查看明文」按密文备份取回）。登录密钥用于打开管理面板，
                不需要配置到 IDE；IDE 用的是访问密钥。
              </Note>
            </div>
          </Panel>
        )}

        <Panel
          title="登录密钥"
          description="用于打开本管理面板，与访问密钥相互独立"
          actions={
            <>
              {loginKeyRow && (
                <Button
                  size="sm"
                  disabled={busyId === '__reveal_login__'}
                  onClick={revealLoginKey}
                >
                  {busyId === '__reveal_login__' ? '读取中…' : '查看明文'}
                </Button>
              )}
              <Button size="sm" onClick={() => setShowLoginInput(true)}>
                输入密钥
              </Button>
              <Button
                size="sm"
                disabled={busyId === '__reset_login__'}
                onClick={async () => {
                  const label = await prompt({
                    title: '重置登录密钥？',
                    message:
                      '重置后旧登录密钥立即失效。新明文只显示一次，请先复制保存；当前会话会自动切换到新密钥，不会被退出。',
                    input: { label: '备注', value: 'login' },
                    okText: '重置',
                    danger: true,
                  });
                  if (typeof label !== 'string') return;
                  setBusyId('__reset_login__');
                  try {
                    const created = await resetLoginKey(label.trim() || 'login', key);
                    // 后端在异常契约下可能不带明文；此时绝不能 setKey(空)，
                    // 那等于把会话清掉并丢掉唯一一次的新密钥展示机会。
                    if (!created || typeof created.key !== 'string' || !created.key) {
                      toast('已重置，但响应未包含新明文，请用 CLI 重新取密钥', 'err');
                      return;
                    }
                    // 顺序关键：先切换会话密钥，再展示明文。
                    // 后端 createKey 已把旧 login 密钥置为 enabled=0，若此时
                    // 仍用旧 key 发 GET /login-key，会得到 401 Invalid login key
                    // → http 层 clearKey + 派发 auth-lost → 本组件连同刚拿到的
                    // 新明文一起卸载，用户被踢回首登引导且无处粘贴新密钥。
                    // key 变化会让列表 / 登录密钥 / 接入配置三个 useAsyncData
                    // 自动用新密钥重拉，无需手动 reload。
                    setKey(created.key);
                    setLoginFresh(created);
                    toast('登录密钥已重置，请立即复制保存', 'ok');
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : '重置失败', 'err');
                  } finally {
                    setBusyId(null);
                  }
                }}
              >
                {busyId === '__reset_login__' ? '重置中…' : '重置登录密钥'}
              </Button>
            </>
          }
        >
          {loginKeys.loading && !loginKeys.data ? (
            <LoadingBlock />
          ) : loginKeys.error ? (
            <ErrorState message={loginKeys.error} onRetry={loginKeys.reload} />
          ) : (
            <>
              <dl className="kv">
                <dt>状态</dt>
                <dd>
                  {loginKeyRow ? (
                    <Chip
                      tone={isKeyUsable(loginKeyRow) ? 'ok' : 'warn'}
                      dot={isKeyUsable(loginKeyRow) ? 'dot-ok' : 'dot-cool'}
                    >
                      {isKeyUsable(loginKeyRow) ? '已配置' : `已配置但${statusLabel(loginKeyRow.status)}`}
                    </Chip>
                  ) : (
                    <Chip tone="danger" dot="dot-error">
                      未配置
                    </Chip>
                  )}
                </dd>
                <dt>备注</dt>
                <dd className="font-mono text-aux">{loginKeyRow?.label || '—'}</dd>
                <dt>掩码</dt>
                <dd className="font-mono text-aux">{loginKeyRow?.hint || '—'}</dd>
                <dt>创建时间</dt>
                <dd className="font-mono text-aux">{formatTime(loginKeyRow?.createdAt)}</dd>
                <dt>最近使用</dt>
                <dd className="font-mono text-aux">{formatTime(loginKeyRow?.lastUsedAt)}</dd>
              </dl>
              {!loginKeyRow && (
                <div className="mt-3">
                  <Note>
                    尚未配置登录密钥，无法打开管理面板。请在服务器上执行{' '}
                    <code className="font-mono">node scripts/login-key.js create</code>{' '}
                    创建，或由本机访问面板走首登引导。
                  </Note>
                </div>
              )}
            </>
          )}
        </Panel>

        <LoginKeyDialog
          open={showLoginInput}
          onClose={() => setShowLoginInput(false)}
          onVerified={() => {
            loginKeys.reload();
            list.reload();
          }}
        />

        <CreateAccessKeyDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            // 与旧的 prompt 路径保持同一收尾：展示明文 + 刷新列表
            revealFresh(created);
            list.reload();
          }}
        />

        <KeyPolicyDialog
          row={policyTarget}
          onClose={() => setPolicyTarget(null)}
          onSaved={list.reload}
        />
      </Stack>
    </PageShell>
  );
}