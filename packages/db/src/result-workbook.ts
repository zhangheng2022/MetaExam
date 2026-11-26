import ExcelJS from 'exceljs';
import type { ResultExport } from '@metaexam/contracts';
const state = { passed: '合格', failed: '不合格', absent: '缺考', all: '全部' };
const type = { single: '单选', multiple: '多选', boolean: '判断', blank: '填空', essay: '简答' };
const time = (s: string) =>
  new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export async function resultWorkbook(data: ResultExport) {
  if (data.records.length > 5000 || data.report.questions.length > 200)
    throw new Error('RESULT_EXPORT_LIMIT');
  const book = new ExcelJS.Workbook();
  book.creator = 'MetaExam';
  book.created = new Date(data.generatedAt);
  const add = (name: string, headers: string[], widths: number[]) => {
    const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = headers.map((header, i) => ({ header, width: widths[i] ?? 20 }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle' };
    return sheet;
  };
  const r = data.report,
    s = r.statistics;
  const overview = add('统计概览', ['项目', '数值或说明'], [26, 85]);
  const entries: (string | number | null)[][] = [
    ['考试', r.name],
    ['课程', r.courseName],
    ['成绩发布时间（北京）', time(r.publishedAt)],
    ['导出时间（北京）', time(data.generatedAt)],
    ['统计范围', '统计概览和逐题统计为全场已发布成绩；成绩名单按筛选导出全部匹配行，不限当前页'],
    ['满分', r.maxScore],
    ['合格比例（%）', s.passPercent],
    ['合格分数线', s.passScore],
    ['名单人数', s.rosterCount],
    ['实考人数', s.presentCount],
    ['缺考人数', s.absentCount],
    ['均分', s.average],
    ['中位数', s.median],
    ['最高分', s.highest],
    ['最低分', s.lowest],
    ['合格人数', s.passedCount],
    ['合格率（%）', s.passRate],
    ['计算口径', '缺考不参与均分、中位数、分布和合格率；实考零分参与；无人实考时相关统计为空'],
    ['名单搜索', data.filters.q || '无'],
    ['名单状态', state[data.filters.status]],
    [
      '名单排序',
      { username: '用户名', score_desc: '分数从高到低', score_asc: '分数从低到高' }[
        data.filters.sort
      ],
    ],
    ['导出名单行数', data.records.length],
    ...s.distribution.map((d) => ['得分率 ' + d.label, d.count]),
  ];
  for (const row of entries) overview.addRow(row);
  overview.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  const roster = add(
    '成绩名单',
    ['用户名', '姓名', '状态', '总分', '满分', '交卷时间（北京）'],
    [24, 26, 14, 14, 14, 26],
  );
  // Assign primitive strings, never formula/hyperlink objects. Keep leading zeros and =/+/-/@ literal.
  for (const row of data.records) {
    const cell = roster.addRow([
      row.username,
      row.displayName,
      state[row.status],
      row.score,
      r.maxScore,
      row.submittedAt ? time(row.submittedAt) : null,
    ]);
    cell.getCell(1).numFmt = '@';
    cell.getCell(2).numFmt = '@';
  }
  roster.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, roster.rowCount), column: 6 },
  };
  const questions = add(
    '逐题统计',
    ['题号', '题型', '满分', '评分人数', '均分', '得分率（%）', '满分人数', '零分人数'],
    [12, 14, 12, 14, 14, 18, 14, 14],
  );
  for (const q of r.questions)
    questions.addRow([
      q.position,
      type[q.type],
      q.maxScore,
      q.gradedCount,
      q.average,
      q.scoreRate,
      q.fullCount,
      q.zeroCount,
    ]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
