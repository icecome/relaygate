import { useCallback, useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import AccountsPanel from '../components/AccountsPanel';
import AccessKeysPanel from '../components/AccessKeysPanel';
import ImportTraeDialog from '../components/ImportTraeDialog';
import ImportWbDialog from '../components/ImportWbDialog';
import OauthTraeDialog from '../components/OauthTraeDialog';
import GrowthPanel from '../components/GrowthPanel';
import { useAuth } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { getStatus } from '../api/admin';
import { checkinAll } from '../api/trae';
import { wbCheckinAll } from '../api/workbuddy';
import type { PoolAccount } from '../api/types';

const TABS = ['all', 'trae', 'wb', 'keys'] as const;
type Tab = (typeof TABS)[number];

export default function AccountsPage() {
  const { tab } = useParams<{ tab: string }>();
  const { key } = useAuth();
  const toast = useToast();

  const [importTraeOpen, setImportTraeOpen] = useState(false);
  const [importWbOpen, setImportWbOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  // 在途数只在 /status 的池快照里，凭据接口不返回
  const [poolAccounts, setPoolAccounts] = useState<PoolAccount[]>([]);

  const loadPool = useCallback(() => {
    if (!key) return;
    getStatus(key)
      .then((d) => {
        const shape = d as { pool?: { accounts?: PoolAccount[] } };
        setPoolAccounts(shape.pool?.accounts ?? []);
      })
      .catch(() => setPoolAccounts([]));
  }, [key]);

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  if (!tab || !TABS.includes(tab as Tab)) return <Navigate to="/accounts/all" replace />;

  if (tab === 'keys') return <AccessKeysPanel loginKey={key} />;

  const isWb = tab === 'wb';
  const platform = isWb ? 'workbuddy' : tab === 'trae' ? 'trae' : 'all';

  const runCheckin = async () => {
    try {
      // Trae 与 WorkBuddy 的批量签到返回结构不同，统一归一成 claimed / failed 计数。
      let claimed = 0;
      let failed = 0;
      if (isWb) {
        const r = await wbCheckinAll(key);
        claimed = r.summary?.claimed ?? r.claimed.length;
        failed = r.summary?.failed ?? r.failed.length;
      } else {
        const r = await checkinAll(key);
        const s = (r.summary ?? null) as Record<string, number> | null;
        claimed = s?.claimed ?? (Array.isArray(r.claimed) ? r.claimed.length : 0);
        failed = s?.failed ?? (Array.isArray(r.failed) ? r.failed.length : 0);
      }
      toast(`签到完成：新领取 ${claimed} · 失败 ${failed}`, failed ? 'warn' : 'ok');
      loadPool();
    } catch (e) {
      toast(`批量签到失败：${(e as Error).message}`, 'err');
    }
  };

  return (
    <>
      <AccountsPanel
        platform={platform}
        onCheckinAll={runCheckin}
        poolAccounts={poolAccounts}
        meta={{
          title: isWb ? 'WorkBuddy 体系' : tab === 'trae' ? 'Trae 体系' : '全部平台',
          emptyTitle: isWb ? '暂无 WorkBuddy 账号' : '暂无 Trae 账号',
          emptyDesc: isWb
            ? '抓取本机 WorkBuddy 登录态，或跨机粘贴 workbuddy-desktop.info 内容导入。'
            : '从 Trae 导出 storage.json 后，用「导入账号」新增条目；每次导入互不覆盖。',
          renderImport: () => (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => (isWb ? setImportWbOpen(true) : setImportTraeOpen(true))}
            >
              导入账号
            </button>
          ),
        }}
        extraActions={
          tab === 'trae' ? (
            <button type="button" className="btn btn-ghost" onClick={() => setOauthOpen(true)}>
              OAuth 登录
            </button>
          ) : null
        }
        extraContent={isWb ? <GrowthPanel /> : null}
      />

      <ImportTraeDialog open={importTraeOpen} onClose={() => setImportTraeOpen(false)} onDone={loadPool} />
      <ImportWbDialog open={importWbOpen} onClose={() => setImportWbOpen(false)} onDone={loadPool} />
      <OauthTraeDialog open={oauthOpen} onClose={() => setOauthOpen(false)} onDone={loadPool} />
    </>
  );
}
