import type { Account } from '../api/types';

export interface SummaryState {
  loading: boolean;
  error: string | null;
  summary: {
    total: number;
    enabled: number;
    disabled: number;
    cooling: number;
    expiring3d: number;
    expiring7d: number;
    accounts: Account[];
  } | null;
  reloadToken: number;
}