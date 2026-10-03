import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import { Note, ICON } from './ui';
import { useToast } from './Toast';
import { usePrompt } from './Prompt';
import {
  listAccessKeys,
  createAccessKey,
  resetAccessKey,
  deleteAccessKey,
  revealAccessKey,
  rotateAccessKey,
  revokeAccessKey,
  type ApiKeyRow,
  type CreatedKey,
} from '../api/admin';

interface Props {
  loginKey: string;
}

/** 访问密钥管理：创建 / 复制 / 重置 / 删除。列表不展示明文，复制经接口取回后写剪贴板。 */
export default function AccessKeysPanel({ loginKey }: Props) {
  const toast = useToast();
  const prompt = usePrompt();
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [platform, setPlatform] = useState<'trae' | 'workbuddy' | 'all'>('trae');

  const platformLabel = (p?: string | null) => {
    if (p === 'all') return '通用';
    if (p === 'workbuddy') return 'WorkBuddy';
    if (p === 'trae') return 'Trae';
    return p || '—';
  };
  const [label, setLabel] = useState('');
  // 创建/重置后的明文弹窗（仅内存，关闭即丢；之后走复制接口）
  const [fresh, setFresh] = useState<CreatedKey | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    if (!loginKey) return;
    setLoading(true);
    setErr('');
    listAccessKeys(loginKey)
      .then((r) => setRows(r.data || []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [loginKey]);

  useEffect(() => {
    load();
  }, [load]);

  async function doCreate() {
    setCreating(true);
    try {
      const created = await createAccessKey({ platform, label: label.trim() || undefined }, loginKey);
      setFresh(created);
      setLabel('');
      toast('访问密钥已创建', 'ok');
      load();
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, 'err');
    } finally {
      setCreating(false);
    }
  }

  async function doReset(row: ApiKeyRow) {
    const ok = await prompt({
      title: '重置访问密钥',
      message: `重置「${row.label || row.id}」后旧密钥立即失效，使用该密钥的客户端需更新。确定继续？`,
      danger: true,
      okText: '重置',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      const created = await resetAccessKey(row.id, loginKey);
      setFresh(created);
      toast('访问密钥已重置，请复制新密钥', 'ok');
      load();
    } catch (e) {
      toast(`重置失败：${(e as Error).message}`, 'err');
    } finally {
      setBusyId('');
    }
  }

  async function doDelete(row: ApiKeyRow) {
    const ok = await prompt({
      title: '删除访问密钥',
      message: `删除「${row.label || row.id}」？使用该密钥的客户端将立即失效，且无法再复制该密钥。`,
      danger: true,
      okText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await deleteAccessKey(row.id, loginKey);
      toast('已删除', 'ok');
      load();
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`, 'err');
    } finally {
      setBusyId('');
    }
  }

  async function doRotate(row: ApiKeyRow) {
    const ok = await prompt({
      title: '轮换访问密钥',
      message: `轮换「${row.label || row.id}」将生成新密钥，旧密钥默认 24 小时宽限期后失效。继续？`,
      okText: '轮换',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      const created = await rotateAccessKey(row.id, loginKey);
      setFresh(created);
      toast('已轮换，请复制新密钥', 'ok');
      load();
    } catch (e) {
      toast(`轮换失败：${(e as Error).message}`, 'err');
    } finally {
      setBusyId('');
    }
  }

  async function doRevoke(row: ApiKeyRow) {
    const ok = await prompt({
      title: '撤销访问密钥',
      message: `撤销「${row.label || row.id}」后立即不可用且不可恢复。继续？`,
      danger: true,
      okText: '撤销',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await revokeAccessKey(row.id, loginKey);
      toast('已撤销', 'ok');
      load();
    } catch (e) {
      toast(`撤销失败：${(e as Error).message}`, 'err');
    } finally {
      setBusyId('');
    }
  }

  const statusPill = (r: ApiKeyRow) => {
    const st = r.status || (r.enabled ? 'active' : 'disabled');
    if (st === 'revoked') return <span className="pill-muted">已撤销</span>;
    if (st === 'expired') return <span className="pill-warn">已过期</span>;
    if (st === 'disabled' || !r.enabled) return <span className="pill-muted">禁用</span>;
    return <span className="pill-ok">启用</span>;
  };

  async function writeClipboard(v: string) {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(v);
      else throw new Error('no clipboard');
      return true;
    } catch {
      return false;
    }
  }

  /** 创建弹窗内直接复制已有明文 */
  async function copyFromFresh() {
    if (!fresh) return;
    const ok = await writeClipboard(fresh.key);
    toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
  }

  /**
   * 列表内复制：界面不展示明文，经 reveal 接口取回后立即写入剪贴板。
   */
  async function copyById(row: ApiKeyRow) {
    setBusyId(row.id);
    try {
      const r = await revealAccessKey(row.id, loginKey);
      const ok = await writeClipboard(r.key);
      toast(ok ? `已复制「${row.label || row.id}」` : '复制失败', ok ? 'ok' : 'err');
    } catch (e) {
      toast(`复制失败：${(e as Error).message}`, 'err');
    } finally {
      setBusyId('');
    }
  }

  if (!loginKey) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-1">访问密钥</h2>
        <p className="text-xs text-ink-soft">请先创建并保存登录密钥后再管理访问密钥。</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 三组易混概念：密钥轮换 / 本机凭据轮换 / 上游任务，作用对象完全不同 */}
      <Note kind="info" icon={ICON.info}>
        访问密钥用于客户端调用 RelayGate。<b>此处「轮换」作用于 API 密钥本身</b>，
        与「运行状态」页的<b>客户端账号轮换</b>（替换本机凭据文件、触发客户端热加载）对象完全不同，
        故分处不同栏目并标注作用域。
      </Note>

      <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">访问密钥</h2>
          <p className="text-xs text-ink-soft">
            供 IDE / Agent 客户端调用转发接口。平台密钥仅调本平台模型；通用密钥（all）可调虚拟模型与全部渠道。列表不展示明文；点击「复制」写入剪贴板。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-ink-soft">
            平台
            <select
              className="field ml-1.5 h-9 min-w-[130px]"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as 'trae' | 'workbuddy' | 'all')}
            >
              <option value="trae">Trae 平台</option>
              <option value="workbuddy">WorkBuddy 平台</option>
              <option value="all">通用（全部模型）</option>
            </select>
          </label>
          <input
            className="field h-9 w-[140px]"
            placeholder="备注（可选）"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="button" className="btn btn-primary" disabled={creating} onClick={doCreate}>
            {creating ? '创建中…' : '创建访问密钥'}
          </button>
        </div>
      </div>

      {err && <div className="text-xs text-danger mb-2">{err}</div>}

      {loading && !rows.length ? (
        <div className="text-xs text-ink-soft py-4">加载中…</div>
      ) : !rows.length ? (
        <div className="text-xs text-ink-soft py-6 text-center border border-dashed border-line-strong rounded-xl">
          暂无访问密钥。选择平台后点击「创建访问密钥」。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] min-w-[560px]">
            <thead>
              <tr>
                <th className="th">平台</th>
                <th className="th">备注</th>
                <th className="th">密钥</th>
                <th className="th">状态</th>
                <th className="th cell-num">最近使用</th>
                <th className="th cell-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-hover">
                  <td className="td">
                    <span className={`${r.platform === 'all' ? 'pill-warn' : r.platform === 'workbuddy' ? 'pill-ok' : 'pill-muted'}`}>
                      {platformLabel(r.platform)}
                    </span>
                  </td>
                  <td className="td text-ink">{r.label || '—'}</td>
                  <td className="td font-mono text-xs text-ink-soft">{r.hint || 'sk-…'}</td>
                  <td className="td">
                    {statusPill(r)}
                    {r.expiresAt && (
                      <div className="text-[11px] text-ink-faint mt-0.5">
                        过期 {new Date(r.expiresAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td className="td cell-num text-xs text-ink-soft">{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : '—'}</td>
                  <td className="td cell-act">
                    <button
                      type="button"
                      className="btn-quiet"
                      disabled={busyId === r.id}
                      onClick={() => copyById(r)}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className="btn-quiet ml-1.5"
                      disabled={busyId === r.id}
                      onClick={() => doRotate(r)}
                    >
                      轮换
                    </button>
                    <button
                      type="button"
                      className="btn-quiet ml-1.5"
                      disabled={busyId === r.id}
                      onClick={() => doReset(r)}
                    >
                      重置
                    </button>
                    <button
                      type="button"
                      className="btn-quiet text-danger ml-1.5"
                      disabled={busyId === r.id || r.status === 'revoked'}
                      onClick={() => doRevoke(r)}
                    >
                      撤销
                    </button>
                    <button
                      type="button"
                      className="btn-quiet text-danger ml-1.5"
                      disabled={busyId === r.id}
                      onClick={() => doDelete(r)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!fresh}
        onClose={() => setFresh(null)}
        title="访问密钥已生成"
        desc={
          <>
            平台 <b>{platformLabel(fresh?.platform)}</b> · 请立即复制保存。关闭后界面不再展示明文，但仍可通过列表「复制」获取。
          </>
        }
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setFresh(null)}>
            关闭
          </button>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border border-line bg-surf-soft p-3">
            <div className="text-xs text-ink-soft mb-1.5">密钥明文（仅本次显示）</div>
            <div className="font-mono text-[13px] break-all select-all text-ink">{fresh?.key}</div>
          </div>
          <button type="button" className="btn btn-primary" onClick={copyFromFresh}>
            复制密钥
          </button>
          <p className="text-xs text-ink-faint">
            接入示例：接口地址 <code className="font-mono">{'{origin}/v1'}</code>，Authorization: Bearer &lt;此密钥&gt;，model 填对应平台的模型 ID。
          </p>
        </div>
      </Modal>
      </div>
    </div>
  );
}
