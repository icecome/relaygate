/**
 * Qoder 运营面与转发面接口（/v1/qoder/*）。
 *
 * 真实语义（对照 src/routes/qoder.js）：
 *   - 凭据只来自本机桌面客户端 auth.v1.dat（双区域），后端不接受请求体传入 token；
 *   - realm 由「扫到哪个客户端目录」确定并随账号持久化，UI 不传 realm 给后端推导；
 *   - 导入为幂等：同 realm+uid 已存在则更新而非重复插入。
 */
import { api } from './http';

/** 本机客户端探测结果（脱敏：只回显 uid/名称/有效期，不回显 token）。 */
export interface QoderLocalRealm {
  installed: boolean;
  appDir: string;
  clientVersion: string | null;
  loggedIn: boolean;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  expiresAt?: string | null;
  error?: string | null;
}

export interface QoderLocalPreview {
  windows: boolean;
  realms: {
    cn: QoderLocalRealm;
    intl: QoderLocalRealm;
  };
}

export interface QoderImportResult {
  ok?: boolean;
  created?: { realm: string; id: string; label: string }[];
  updated?: { realm: string; id: string; label: string }[];
  skipped?: { realm: string; reason: string }[];
  message?: string;
  error?: { message?: string };
}

/** 预检本机客户端（双区域，不解密全文）。 */
export const qoderLocalPreview = (key: string, signal?: AbortSignal) =>
  api<QoderLocalPreview>('/v1/qoder/local/preview', { signal }, key);

/**
 * 导入本机已登录的全部区域账号。
 * 幂等：同 realm+uid 更新而非重复插入。
 */
export const qoderImportLocal = (key: string) =>
  api<QoderImportResult>('/v1/qoder/local/import', { method: 'POST' }, key);

/** 导入指定区域的账号。 */
export const qoderImportRealm = (realm: 'cn' | 'intl', key: string) =>
  api<{ ok?: boolean; account?: { id: string; label: string }; action?: string }>(
    `/v1/qoder/local/import/${realm}`,
    { method: 'POST' },
    key,
  );
