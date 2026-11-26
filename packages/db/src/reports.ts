import type { PoolClient } from 'pg';
import type {
  ExamReport,
  ExamSummary,
  ReportFilters,
  ReportQuery,
  ResultExport,
  ResultRecord,
  PageResult,
  QuestionStatistics,
} from '@metaexam/contracts';
import { selectResults, summarizeResults, type ScoredRecord } from '@metaexam/domain';
import type { Database } from './index';
import { ExamRepository } from './exams';
import { IdentityError, audit, type AuditContext } from './identity';
export class ReportRepository {
  private readonly exams: ExamRepository;
  constructor(readonly db: Database) {
    this.exams = new ExamRepository(db);
  }
  private async published(c: PoolClient, e: ExamSummary) {
    const p = (
      await c.query<{ published_at: Date | null }>(
        'SELECT published_at FROM exam_grading WHERE exam_id=$1',
        [e.id],
      )
    ).rows[0];
    if (e.status !== 'published' || !p?.published_at)
      throw new IdentityError('RESULTS_UNPUBLISHED', 409);
    return p.published_at.toISOString();
  }
  private async records(c: PoolClient, e: ExamSummary): Promise<ScoredRecord[]> {
    const rows = (
      await c.query<{
        id: string;
        username: string;
        display_name: string;
        attempt_id: string | null;
        status: string | null;
        submitted_at: Date | null;
        points: string | null;
        scored: number;
      }>(
        `SELECT r.user_id AS id,r.username,r.display_name,a.id AS attempt_id,a.status,a.submitted_at,s.points,s.scored FROM exam_roster r LEFT JOIN exam_attempts a ON a.exam_id=r.exam_id AND a.user_id=r.user_id LEFT JOIN LATERAL(SELECT sum(score_units) AS points,count(score_units)::int AS scored FROM attempt_scores WHERE attempt_id=a.id) s ON true WHERE r.exam_id=$1 ORDER BY r.username,r.user_id LIMIT 5001`,
        [e.id],
      )
    ).rows;
    if (
      rows.length > 5000 ||
      rows.some(
        (r) =>
          r.attempt_id &&
          (r.status !== 'submitted' || r.scored !== e.itemCount || r.points === null),
      )
    )
      throw new IdentityError('RESULTS_INCONSISTENT', 503);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      scoreUnits: r.attempt_id ? Number(r.points) : null,
      submittedAt: r.submitted_at?.toISOString() ?? null,
    }));
  }
  private async report(
    c: PoolClient,
    e: ExamSummary,
    publishedAt: string,
    rows: ScoredRecord[],
    passPercent: number,
  ): Promise<ExamReport> {
    const raw = (
      await c.query<{
        position: number;
        type: QuestionStatistics['type'];
        max: number;
        count: number;
        average: number | null;
        full: number;
        zero: number;
      }>(
        `SELECT i.position,v.content->'content'->>'type' AS type,i.score_units AS max,s.count,s.average,s.full,s.zero FROM paper_version_items i JOIN question_versions v ON v.id=i.question_version_id LEFT JOIN LATERAL(SELECT count(*)::int AS count,avg(x.score_units)::float8 AS average,count(*) FILTER(WHERE x.score_units=i.score_units)::int AS full,count(*) FILTER(WHERE x.score_units=0)::int AS zero FROM attempt_scores x JOIN exam_attempts a ON a.id=x.attempt_id WHERE a.exam_id=$1 AND x.position=i.position) s ON true WHERE i.paper_version_id=$2 ORDER BY i.position`,
        [e.id, e.paperVersionId],
      )
    ).rows;
    return {
      examId: e.id,
      name: e.name,
      courseName: e.courseName,
      publishedAt,
      maxScore: e.totalScore,
      statistics: summarizeResults(rows, e.totalScore * 2, passPercent),
      questions: raw.map((r) => ({
        position: r.position,
        type: r.type,
        maxScore: r.max / 2,
        gradedCount: r.count,
        average: r.average === null ? null : Math.round(r.average * 50) / 100,
        scoreRate: r.average === null ? null : Math.round((r.average * 10000) / r.max) / 100,
        fullCount: r.full,
        zeroCount: r.zero,
      })),
    };
  }
  summary(actor: string, id: string, passPercent: number) {
    return this.exams.withAccess(actor, id, false, async (c, e) => {
      const publishedAt = await this.published(c, e),
        rows = await this.records(c, e);
      return this.report(c, e, publishedAt, rows, passPercent);
    });
  }
  list(actor: string, id: string, q: ReportQuery): Promise<PageResult<ResultRecord>> {
    return this.exams.withAccess(actor, id, false, async (c, e) => {
      await this.published(c, e);
      const selected = selectResults(await this.records(c, e), e.totalScore * 2, q);
      return {
        items: selected.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
        total: selected.length,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  prepare(actor: string, id: string, filters: ReportFilters): Promise<ResultExport> {
    return this.exams.withAccess(actor, id, false, async (c, e) => {
      const publishedAt = await this.published(c, e),
        rows = await this.records(c, e);
      return {
        report: await this.report(c, e, publishedAt, rows, filters.passPercent),
        filters,
        records: selectResults(rows, e.totalScore * 2, filters),
        generatedAt: new Date().toISOString(),
      };
    });
  }
  authorizeDownload(actor: string, id: string, data: ResultExport, ctx: AuditContext) {
    return this.exams.withAccess(actor, id, true, async (c, e) => {
      if ((await this.published(c, e)) !== data.report.publishedAt)
        throw new IdentityError('RESULTS_INCONSISTENT', 503);
      await audit(c, 'results.export', 'success', ctx, actor, {
        type: 'exam',
        id,
        details: {
          rows: data.records.length,
          status: data.filters.status,
          sort: data.filters.sort,
          passPercent: data.filters.passPercent,
        },
      });
    });
  }
}
