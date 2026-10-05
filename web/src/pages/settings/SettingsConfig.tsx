import { useCallback, useEffect, useState } from 'react';
import { useAuth, setKey, clearKey } from '../../stores/useAuth';
import { useToast } from '../../components/Toast';
import {
  getClientConfig,
  getRuntimeConfig,
  reloadConfig,
  type ClientConfig,
  type RuntimeConfig,
} from '../../api/admin';
import { pad2 } from './shared';

type Status = { msg: string; kind: '' | 'ok' | 'err' };

/** 配置视图：登录密钥、客户端接入信息、服务信息与运行时配置（只读 + 热重载）。 */
export default function SettingsConfig() {
  const { key } = useAuth();
  const toast = useToast();
  const [inputKey, setInputKey] = useState(key);
  const [showKey, setShowKey] = useState(false);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [keyStatus, setKeyStatus] = useState<Status>({ msg: '', kind: '' });
  const [rtConfig, setRtConfig] = useState<RuntimeConfig | null>(null);
  const [rtStatus, setRtStatus] = useState<Status>({ msg: '', kind: '' });
  const [rtReloading, setRtReloading] = useState(false);

  const loadConfig = useCallback(() => {
    if (!key) {
      setConfig(null);
      return;
    }
    getClientConfig(key)
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [key]);

  const loadRtConfig = useCallback(() => {
    if (!key) {
      setRtConfig(null);
      setRtStatus({ msg: '', kind: '' });
      return;
    }
    setRtStatus({ msg: '', kind: '' });
    getRuntimeConfig(key)
      .then((d) => {
        setRtConfig(d);
        setRtStatus({ msg: '', kind: '' });
      })
      .catch((e: Error) => {
        // 与通知/定时视图同口径：失败写状态，界面才能区分「加载中」与「加载失败」
        setRtConfig(null);
        setRtStatus({ msg: `运行时配置加载失败：${e.message}`, kind: 'err' });
      });
  }, [key]);

  useEffect(() => {
    setInputKey(key);
    loadConfig();
    loadRtConfig();
  }, [key, loadConfig, loadRtConfig]);

  function saveKey() {
    const v = inputKey.trim();
    setKey(v);
    setKeyStatus({ msg: '密钥已保存', kind: 'ok' });
    toast('密钥已保存并连接');
  }

  async function doReloadConfig() {
    if (!key) {
      setRtStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    setRtReloading(true);
    try {
      const r = await reloadConfig(key);
      setRtStatus({ msg: `已重载：${r.after.modelCount} 个模型，池策略 ${r.after.poolStrategy}`, kind: 'ok' });
      toast('配置已重载', 'ok');
      loadRtConfig();
    } catch (e) {
      setRtStatus({ msg: `重载失败：${(e as Error).message}`, kind: 'err' });
      toast('配置重载失败', 'err');
    } finally {
      setRtReloading(false);
    }
  }

  const configRows = [
    ['站点 BASE URL', config?.baseUrl, true],
    ['OpenAI BASE URL', config?.openai?.OPENAI_BASE_URL, true],
    ['Anthropic BASE URL', config?.anthropic?.ANTHROPIC_BASE_URL, true],
    ['Codex（Responses）', config?.codex?.base_url, true],
  ] as const;

  const copyRow = async (v: string) => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(v);
      else throw new Error();
      toast('已复制', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">登录密钥</h2>
        <p className="text-xs text-ink-soft mb-4">
          用于本管理面板登录（Authorization: Bearer）。与「访问密钥」分离：访问密钥在概览页管理，供 IDE 调用转发接口。密钥仅保存在本机浏览器。
        </p>
        <label className="block text-xs font-medium text-ink-soft mb-2" htmlFor="api-key">
          登录密钥
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            id="api-key"
            className="field flex-1 min-w-[200px] h-10"
            type={showKey ? 'text' : 'password'}
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            placeholder="粘贴登录密钥"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn btn-ghost btn-sm h-10" onClick={() => setShowKey((s) => !s)}>
            {showKey ? '隐藏' : '显示'}
          </button>
          <button type="button" className="btn btn-primary" onClick={saveKey}>
            保存并连接
          </button>
          <button type="button" className="btn btn-ghost" onClick={clearKey}>
            清除
          </button>
        </div>
        <p className="text-xs text-ink-faint mt-2.5">
          登录密钥丢失或需轮换：在服务器执行 <code className="font-mono">node scripts/login-key.js reset</code>，明文仅终端显示一次。
          IDE/客户端请使用概览页创建的「访问密钥」调用 /v1/chat*。
        </p>
        {keyStatus.msg && (
          <div role="status" className={`text-xs mt-2.5 ${keyStatus.kind === 'ok' ? 'text-acc-hover' : keyStatus.kind === 'err' ? 'text-danger' : ''}`}>
            {keyStatus.msg}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">客户端配置</h2>
        <p className="text-xs text-ink-soft mb-4">转发接口的接入地址与协议端点（只读）。转发面使用「访问密钥」，管理面板使用「登录密钥」。</p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存登录密钥后展示接入信息</div>
        ) : (
          <div className="grid gap-2.5">
            {configRows.map(([k, v, copyable]) => (
              <div key={k} className="kv-row">
                <span className="kv-k">{k}</span>
                <span className="kv-v">
                  {v || '—'}
                  {copyable && v && (
                    <button type="button" className="btn-quiet ml-1" onClick={() => copyRow(v)}>
                      复制
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {config?.notes?.length ? <p className="text-xs text-ink-faint mt-3">说明：{config.notes.join('；')}</p> : null}
      </div>

      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">服务信息</h2>
        <p className="text-xs text-ink-soft mb-4">当前页面可推断的连接信息（只读）。</p>
        <div className="grid gap-2.5">
          <div className="kv-row"><span className="kv-k">站点</span><span className="kv-v">{typeof location !== 'undefined' ? location.origin : '—'}</span></div>
          <div className="kv-row"><span className="kv-k">摘要接口</span><span className="kv-v">/v1/credentials/summary</span></div>
          <div className="kv-row"><span className="kv-k">登录密钥存储</span><span className="kv-v">localStorage · trae_key</span></div>
          <div className="kv-row"><span className="kv-k">访问密钥</span><span className="kv-v">概览页管理 · 按平台绑定</span></div>
          <div className="kv-row"><span className="kv-k">通知</span><span className="kv-v">{key ? '已配置' : '—'}</span></div>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="text-block-title font-semibold mb-1">运行时配置</h2>
        <p className="text-xs text-ink-soft mb-4">当前生效的关键配置（只读）。「重新加载」会重读 model-config.json 与 .env 可热更项，无需重启服务。端口/密钥等监听级配置需重启生效。</p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存访问密钥后展示运行时配置</div>
        ) : rtConfig ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-3">
              <div className="kv-row"><span className="kv-k">池策略</span><span className="kv-v">{rtConfig.poolStrategy}</span></div>
              <div className="kv-row"><span className="kv-k">单账号在途</span><span className="kv-v">{rtConfig.maxInFlightPerAccount}</span></div>
              <div className="kv-row"><span className="kv-k">最低余额</span><span className="kv-v">{rtConfig.minBalanceToUse}</span></div>
              <div className="kv-row"><span className="kv-k">出站节流</span><span className="kv-v">{rtConfig.ratePaceMs}ms / 窗口 {rtConfig.rateWindowMax}次/{Math.round(rtConfig.rateWindowMs / 1000)}s</span></div>
              <div className="kv-row"><span className="kv-k">签到时刻</span><span className="kv-v">{rtConfig.checkinHour}:{pad2(rtConfig.checkinMinute ?? 0)}</span></div>
              <div className="kv-row"><span className="kv-k">保活时刻</span><span className="kv-v">{rtConfig.keepaliveHour}:00</span></div>
              <div className="kv-row"><span className="kv-k">上游函数</span><span className="kv-v">{rtConfig.upstreamFunction || '按模型映射'}</span></div>
              <div className="kv-row"><span className="kv-k">上游路径</span><span className="kv-v">{rtConfig.upstreamChatPath}</span></div>
              <div className="kv-row"><span className="kv-k">工具协议</span><span className="kv-v">{rtConfig.toolProtocol}</span></div>
              <div className="kv-row"><span className="kv-k">重试</span><span className="kv-v">{rtConfig.maxRetries} 次 / 基础 {rtConfig.retryBaseDelay}ms</span></div>
              <div className="kv-row"><span className="kv-k">请求超时</span><span className="kv-v">{Math.round(rtConfig.requestTimeoutMs / 1000)}s</span></div>
              <div className="kv-row"><span className="kv-k">定时任务</span><span className="kv-v">{rtConfig.schedulerEnabled ? '已启用' : '已关闭'}</span></div>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary" onClick={doReloadConfig} disabled={rtReloading}>
                {rtReloading ? '重载中…' : '重新加载配置'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={loadRtConfig}>刷新</button>
            </div>
            {rtStatus.msg && (
              <div role="status" className={`text-xs mt-2.5 ${rtStatus.kind === 'ok' ? 'text-acc-hover' : rtStatus.kind === 'err' ? 'text-danger' : ''}`}>
                {rtStatus.msg}
              </div>
            )}
          </>
        ) : rtStatus.kind === 'err' ? (
          <>
            <div role="alert" className="text-xs text-danger mb-3">{rtStatus.msg}</div>
            <button type="button" className="btn btn-ghost" onClick={loadRtConfig}>重试</button>
          </>
        ) : (
          <div className="text-xs text-ink-soft">加载中…</div>
        )}
      </div>
    </div>
  );
}