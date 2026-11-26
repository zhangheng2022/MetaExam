import type { ReportFilters, ResultRecord, ResultStatistics } from '@metaexam/contracts';
export interface ScoredRecord {
  id: string;
  username: string;
  displayName: string;
  scoreUnits: number | null;
  submittedAt: string | null;
}
export function summarizeResults(
  rows: ScoredRecord[],
  maxUnits: number,
  passPercent: number,
): ResultStatistics {
  const points = rows
      .flatMap((r) => (r.scoreUnits === null ? [] : [r.scoreUnits]))
      .sort((a, b) => a - b),
    n = points.length;
  const passed = points.filter((p) => p * 100 >= maxUnits * passPercent).length;
  const distribution = Array.from({ length: 5 }, (_, i) => ({
    label: i === 4 ? '80%～100%' : `${i * 20}%～不足 ${(i + 1) * 20}%`,
    count: 0,
  }));
  for (const p of points) distribution[Math.min(4, Math.floor((p * 5) / maxUnits))]!.count++;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    rosterCount: rows.length,
    presentCount: n,
    absentCount: rows.length - n,
    average: n ? round(points.reduce((s, p) => s + p, 0) / n / 2) : null,
    median: n ? round((points[Math.floor((n - 1) / 2)]! + points[Math.floor(n / 2)]!) / 4) : null,
    highest: n ? points[n - 1]! / 2 : null,
    lowest: n ? points[0]! / 2 : null,
    passedCount: passed,
    passRate: n ? round((passed * 100) / n) : null,
    passPercent,
    passScore: (maxUnits * passPercent) / 200,
    distribution,
  };
}
export function selectResults(
  rows: ScoredRecord[],
  maxUnits: number,
  filters: ReportFilters,
): ResultRecord[] {
  const selected = rows
    .map(
      (r): ResultRecord => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        score: r.scoreUnits === null ? null : r.scoreUnits / 2,
        status:
          r.scoreUnits === null
            ? 'absent'
            : r.scoreUnits * 100 >= maxUnits * filters.passPercent
              ? 'passed'
              : 'failed',
        submittedAt: r.submittedAt,
      }),
    )
    .filter(
      (r) =>
        (filters.status === 'all' || r.status === filters.status) &&
        `${r.username} ${r.displayName}`.toLowerCase().includes(filters.q.toLowerCase()),
    );
  return selected.sort((a, b) => {
    if (filters.sort !== 'username') {
      if (a.score === null && b.score !== null) return 1;
      if (b.score === null && a.score !== null) return -1;
      if (a.score !== null && b.score !== null && a.score !== b.score)
        return filters.sort === 'score_desc' ? b.score - a.score : a.score - b.score;
    }
    return a.username < b.username
      ? -1
      : a.username > b.username
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
}
