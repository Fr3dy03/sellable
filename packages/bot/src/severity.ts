import type { Severity } from '@sellable/db';

const RANK: Record<Severity, number> = { info: 0, warn: 1, danger: 2 };

export const severityRank = (s: Severity): number => RANK[s];

export const meetsMinSeverity = (min: Severity, severity: Severity): boolean =>
  RANK[severity] >= RANK[min];
