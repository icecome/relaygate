import type { Account } from '../api/types';
import { fmtBalance, fmtExpiry } from '../lib/format';

export interface ExpiryRow {
  name: string;
  packName: string;
  remaining: string;
  used: string;
  expire: string;
  win: string;
  is3: boolean;
}

/** 计算账号权益包的临期行（3/7 天窗口），供 Trae/Workbuddy 两页复用。 */
export function buildExpiryRows(accounts: Account[]): ExpiryRow[] {
  return accounts
    .flatMap((a) =>
      (a.packs || []).map((p) => {
        const now = Date.now();
        const startOfDay = (ms: number) => {
          const d = new Date(ms);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        };
        const dayDiff =
          p.expireTime != null
            ? Math.round((startOfDay(p.expireTime * 1000) - startOfDay(now)) / 86400000)
            : NaN;
        const win = Number.isNaN(dayDiff)
          ? ''
          : dayDiff < 0
            ? '已过期'
            : dayDiff <= 3
              ? '3 天内'
              : dayDiff <= 7
                ? '7 天内'
                : '';
        if (!win) return null;
        return {
          name: a.label || a.id,
          packName: p.name || (p.unlimited ? '不限量包' : '积分包'),
          remaining: p.unlimited ? '不限量' : fmtBalance(p.remaining),
          used: fmtBalance(p.used),
          expire: fmtExpiry(p.expireTime),
          win,
          is3: win === '3 天内' || win === '已过期',
        };
      }),
    )
    .filter((r): r is ExpiryRow => !!r)
    .sort((x, y) =>
      x.is3 !== y.is3 ? (x.is3 ? -1 : 1) : String(x.name).localeCompare(String(y.name)),
    );
}
