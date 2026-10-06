/**
 * 访问密钥页：创建、轮换、吊销、重置与一次性明文查看。
 *
 * 真实语义：明文 key 仅在创建、轮换、重置、reveal 时返回一次，
 * 列表接口只返回掩码。页面据此设计 —— 列表恒用掩码，
 * 明文只出现在「最近生成」区域，避免长期暴露在屏幕上。
 */
import { useMemo, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  createAccessKey,
  deleteAccessKey,
  isKeyUsable,
  listAccessKeys,
  listLoginKeys,
  maskKey,
  resetAccessKey,
  resetLoginKey,
  revokeAccessKey,
  revealAccessKey,
  rotateAccessKey,
  type CreatedKey,
} from '../../shared/api/apiKeys';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatTime } from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  LoadingBlock,
  Note,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';
import { LoginKeyDialog } from './LoginKeyDialog';

type Filter = 'all' | 'active' | 'revoked';

/** 后端 status 字段的中文文案。 */
const STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  disabled: '已停用',
  revoked: '已吊销',
  expired: '已过期',
};

/** 未知 status 兜底，避免映射缺失导致渲染中断。 */
function statusLabel(status: string | undefined): string {
  return STATUS_LABEL[status ?? 'active'] ?? status ?? '生效中';
}

export default function AccessKeysPage() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();

  const [filter, setFilter] = useState<Filter>('all');
  const [fresh, setFresh] = useState<CreatedKey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showLoginInput, setShowLoginInput] = useState(false);

  const list = useAsyncData((signal) => listAccessKeys(key, signal), [key], { enabled: !!key });
  // 登录密钥接口返回 { object, data }，是否已配置由列表长度判断
  const loginKeys = useAsyncData((signal) => listLoginKeys(key, signal), [key], { enabled: !!key });

  const rows = useMemo(() => {
    const all = list.data?.data ?? [];
    if (filter === 'all') return all;
    return filter === 'active' ? all.filter(isKeyUsable) : all.filter((r) => !isKeyUsable(r));
  }, [list.data, filter]);

  /** 已配置的登录密钥（后端可能存在多条，取最新一条）。 */
  const loginKeyRow = loginKeys.data?.data?.[0] ?? null;

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
    const label = await prompt({
      title: '创建访问密钥',
      message: '明文仅在创建时返回一次，请立即保存。',
      input: { label: '备注', value: '' },
      okText: '创建',
    });
    if (typeof label !== 'string') return;
    setBusyId('__create__');
    try {
      const created = await createAccessKey({ label: label.trim() || undefined }, key);
      revealFresh(created);
      toast('密钥已创建，请立即复制保存', 'ok');
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '创建失败', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(id: string) {
    const ok = await prompt({
      title: '轮换该密钥？',
      message: '旧密钥将进入宽限期后失效。',
      okText: '轮换',
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(id);
    try {
      const created = await rotateAccessKey(id, 0, key);
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
    const ok = await prompt({ title: '重置该密钥？', okText: '重置', danger: true });
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

  async function remove(id: string) {
    const ok = await prompt({ title: '删除该密钥？', okText: '删除', danger: true });
    if (ok !== true) return;
    await run(id, '删除', () => deleteAccessKey(id, key), '已删除');
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

  return (
    <PageShell
      title="访问密钥"
      description="供 IDE 调用转发接口的密钥，与登录密钥分离"
      actions={
        <Button variant="primary" onClick={create} disabled={busyId === '__create__'}>
          {busyId === '__create__' ? '创建中…' : '创建密钥'}
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
              { value: 'revoked', label: '不可用' },
            ]}
          />
          <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            共 {rows.length} 个密钥
          </span>
        </>
      }
    >
      <Stack>
        {list.error && <ErrorState message={list.error} onRetry={list.reload} />}

        <Panel title="访问密钥" flush>
          {list.loading && !list.data ? (
            <LoadingBlock />
          ) : rows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无访问密钥
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">备注</th>
                  <th className="th">平台</th>
                  <th className="th">密钥</th>
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
                  return (
                    <tr key={r.id} className="row-hover">
                      <td className="td font-mono text-[12px]">{r.label || '—'}</td>
                      <td className="td">{r.platform || 'all'}</td>
                      <td className="td font-mono text-[12px]">{r.hint || maskKey(r.id)}</td>
                      <td className="td">
                        <Chip
                          tone={usable ? 'ok' : r.status === 'disabled' ? 'neutral' : 'danger'}
                          dot={usable ? 'dot-ok' : r.status === 'disabled' ? 'dot-off' : 'dot-error'}
                        >
                          {statusLabel(r.status)}
                        </Chip>
                      </td>
                      <td className="td font-mono text-[12px]">{formatTime(r.createdAt)}</td>
                      <td className="td font-mono text-[12px]">{formatTime(r.lastUsedAt)}</td>
                      <td className="td cell-act">
                        <div className="inline-flex items-center gap-1.5">
                          <Button size="sm" disabled={busy || !usable} onClick={() => reveal(r.id)}>
                            查看
                          </Button>
                          <Button size="sm" disabled={busy || !usable} onClick={() => rotate(r.id)}>
                            轮换
                          </Button>
                          <Button size="sm" disabled={busy} onClick={() => reset(r.id)}>
                            重置
                          </Button>
                          <Button size="sm" disabled={busy || !usable} onClick={() => revoke(r.id)}>
                            吊销
                          </Button>
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => remove(r.id)}>
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
            <div
              className="rounded-md border p-3 font-mono text-[13px] break-all select-all"
              style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
            >
              {fresh.key}
            </div>
            <div className="mt-3">
              <Note>明文仅在创建、轮换、重置与查看时返回，关闭后无法再次获取。</Note>
            </div>
          </Panel>
        )}

        <Panel
          title="登录密钥"
          description="用于打开本管理面板，与访问密钥相互独立"
          actions={
            <>
              <Button size="sm" onClick={() => setShowLoginInput(true)}>
                输入密钥
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const label = await prompt({
                    title: '重置登录密钥？',
                    message: '重置后旧登录密钥立即失效，当前会话将回到首登引导。',
                    input: { label: '备注', value: 'login' },
                    okText: '重置',
                    danger: true,
                  });
                  if (typeof label !== 'string') return;
                  try {
                    const created = await resetLoginKey(label.trim() || 'login', key);
                    revealFresh(created);
                    loginKeys.reload();
                    toast('登录密钥已重置，请立即复制保存', 'ok');
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : '重置失败', 'err');
                  }
                }}
              >
                重置登录密钥
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
                <dd className="font-mono text-[12px]">{loginKeyRow?.label || '—'}</dd>
                <dt>掩码</dt>
                <dd className="font-mono text-[12px]">{loginKeyRow?.hint || '—'}</dd>
                <dt>创建时间</dt>
                <dd className="font-mono text-[12px]">{formatTime(loginKeyRow?.createdAt)}</dd>
                <dt>最近使用</dt>
                <dd className="font-mono text-[12px]">{formatTime(loginKeyRow?.lastUsedAt)}</dd>
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
      </Stack>
    </PageShell>
  );
}