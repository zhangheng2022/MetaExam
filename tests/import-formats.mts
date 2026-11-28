import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseWorkbook, IMPORT_HEADERS } from '../packages/db/dist/file-processor.js';
const require = createRequire(path.resolve('packages/db/package.json'));
const Excel = require('exceljs');
// Independent source-format fixture; never includes the user's question content.
const headers = [
  '题目ID',
  '题目类型',
  '题目难度',
  '题目描述',
  '选项A',
  '选项B',
  '选项C',
  '选项D',
  '选项E',
  '选项F',
  '正确答案',
  '题目解析',
  '关联知识点ID',
  '课程ID',
  '题库ID',
];
export const textRows: unknown[][] = [
  [
    '',
    '单选文本题',
    '容易',
    '文字格式：选择数字二',
    '1',
    '2',
    '',
    '',
    '',
    '',
    'B',
    '数字辨认',
    '',
    '',
    '',
  ],
  [
    '',
    '多选文本题',
    '容易',
    '文字格式：选择偶数',
    '2',
    '3',
    '4',
    '',
    '',
    '',
    'A|C',
    '',
    '',
    '',
    '',
  ],
  ['', '判断题', '容易', '文字格式：四是偶数', '', '', '', '', '', '', '正确', '', '', '', ''],
];
export function textWorkbook(rows = textRows, headerRow = 2, name = '外部题库') {
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet(name);
  sheet.getRow(headerRow).values = headers;
  rows.forEach((row, i) => {
    sheet.getRow(headerRow + i + 1).values = row;
  });
  return book;
}
export async function verifyImportFormats() {
  for (const headerRow of [1, 2]) {
    const book = textWorkbook(textRows, headerRow, headerRow === 1 ? '任意名称' : 'Sheet1');
    const rows = await parseWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
    assert.deepEqual(
      rows.map((r) => r.rowNumber),
      [1, 2, 3].map((i) => i + headerRow),
    );
    assert.ok(rows.every((r) => !r.errors.length && r.question?.difficulty === 2));
    assert.deepEqual(
      rows.map((r) => r.question?.content.type),
      ['single', 'multiple', 'boolean'],
    );
    assert.deepEqual(
      rows.map((r) => r.question?.stem),
      textRows.map((r) => r[3]),
    );
    assert.equal(rows[0]!.question!.explanation, '数字辨认');
    for (const r of rows) {
      const q = r.question!;
      assert.deepEqual(q.tags, []);
      assert.deepEqual(q.knowledgePoints, []);
      if (q.content.type === 'single' || q.content.type === 'multiple') {
        const content = q.content;
        assert.deepEqual(
          content.answer.map((id) => content.options.find((o) => o.id === id)!.text),
          q.content.type === 'single' ? ['2'] : ['2', '4'],
        );
      } else if (q.content.type === 'boolean') assert.equal(q.content.answer, true);
    }
    assert.equal(
      (
        await parseWorkbook(
          Buffer.from(
            await textWorkbook(
              Array.from({ length: 500 }, () => textRows[2]!),
              headerRow,
            ).xlsx.writeBuffer(),
          ),
        )
      ).length,
      500,
    );
    await assert.rejects(
      parseWorkbook(
        Buffer.from(
          await textWorkbook(
            Array.from({ length: 501 }, () => textRows[2]!),
            headerRow,
          ).xlsx.writeBuffer(),
        ),
      ),
      /INVALID_WORKBOOK/,
    );
  }
  const levels = [
    '很容易',
    '容易',
    '中等',
    '困难',
    '很困难',
    1,
    2,
    3,
    4,
    5,
    '1',
    '2',
    '3',
    '4',
    '5',
  ];
  const styled = textWorkbook();
  styled.worksheets[0].getCell('P3').font = { bold: true };
  assert.equal((await parseWorkbook(Buffer.from(await styled.xlsx.writeBuffer()))).length, 3);
  const levelRows = levels.map((level) => {
    const row = [...textRows[2]!];
    row[2] = level;
    return row;
  });
  const parsedLevels = await parseWorkbook(
    Buffer.from(await textWorkbook(levelRows).xlsx.writeBuffer()),
  );
  assert.deepEqual(
    parsedLevels.map((r) => r.question?.difficulty),
    levels.map((_, i) => (i % 5) + 1),
  );
  const errors: [number, unknown, RegExp][] = [
    ...[0, 12, 13, 14].map((i): [number, unknown, RegExp] => [i, '外部标识', /必须为空/]),
    [2, '', /题目难度/],
    [2, '未知', /题目难度/],
    [2, 6, /题目难度/],
    [1, '填空题', /题目类型/],
    [10, 'Z', /有效选项/],
    [10, 'A|B', /单选题/],
    [4, '', /连续填写/],
    [5, '1', /选项内容不能重复/],
    [0, { formula: '1+1', result: 2 }, /不能使用公式或链接/],
    [3, { formula: '1+1', result: 2 }, /不能使用公式或链接/],
  ];
  for (const [column, value, message] of errors) {
    const row = [...textRows[0]!];
    row[column] = value;
    const result = await parseWorkbook(Buffer.from(await textWorkbook([row]).xlsx.writeBuffer()));
    assert.equal(result[0]!.rowNumber, 3);
    assert.equal(result[0]!.question, null);
    assert.match(result[0]!.errors.join(';'), message);
  }
  for (const kind of [
    'header',
    'order',
    'prefix',
    'multiple',
    'mixed',
    'extra',
    'hidden-sheet',
    'hidden-header',
    'merge',
    'link',
    'hidden-row',
  ]) {
    const book = textWorkbook();
    const sheet = book.worksheets[0];
    if (kind === 'header') sheet.getCell('B2').value = '类型';
    if (kind === 'order') {
      sheet.getCell('B2').value = '题目难度';
      sheet.getCell('C2').value = '题目类型';
    }
    if (kind === 'prefix') sheet.getCell('A1').value = '标题';
    if (kind === 'multiple') book.addWorksheet('另一题库').addRow(headers);
    if (kind === 'mixed') book.addWorksheet('题目').addRow(IMPORT_HEADERS);
    if (kind === 'extra') sheet.getCell('P3').value = '多余内容';
    if (kind === 'hidden-sheet') sheet.state = 'hidden';
    if (kind === 'hidden-header') sheet.getRow(2).hidden = true;
    if (kind === 'merge') sheet.mergeCells('D3:E3');
    if (kind === 'link')
      sheet.getCell('D3').value = { text: '链接', hyperlink: 'https://example.com' };
    if (kind === 'hidden-row') {
      sheet.getRow(3).hidden = true;
      const rows = await parseWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
      assert.match(rows[0]!.errors.join(';'), /隐藏/);
      assert.equal(rows[0]!.question, null);
    } else
      await assert.rejects(
        parseWorkbook(Buffer.from(await book.xlsx.writeBuffer())),
        /INVALID_TEMPLATE|INVALID_WORKBOOK/,
        kind,
      );
  }
  await assert.rejects(
    parseWorkbook(Buffer.from(await textWorkbook([]).xlsx.writeBuffer())),
    /EMPTY_WORKBOOK/,
  );
  console.log(
    'PASS text import formats, source rows, difficulty, ID restrictions, 500-row limits and unsafe workbook rejection',
  );
}
