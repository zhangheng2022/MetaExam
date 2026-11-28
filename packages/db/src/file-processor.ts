import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { resultWorkbook } from './result-workbook';
import sharp from 'sharp';
import yauzl from 'yauzl';
import type { AccountImportInput } from '@metaexam/contracts';
import { questionInputSchema, type ImportRow, type QuestionInput } from '@metaexam/contracts';
export const IMPORT_HEADERS = [
  '题型',
  '题干',
  '选项A',
  '选项B',
  '选项C',
  '选项D',
  '选项E',
  '选项F',
  '选项G',
  '选项H',
  '答案',
  '解析',
  '难度',
  '知识点',
  '标签',
  '填空区分大小写',
  '填空忽略首尾空白',
];
export const TEXT_IMPORT_HEADERS = [
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
const textTypes = new Map([
  ['单选文本题', '单选'],
  ['多选文本题', '多选'],
  ['判断题', '判断'],
]);
const textDifficulties = new Map([
  ['很容易', '1'],
  ['容易', '2'],
  ['中等', '3'],
  ['困难', '4'],
  ['很困难', '5'],
]);

function normalizeTextRow(values: string[], errors: string[]): string[] {
  for (const i of [0, 12, 13, 14]) {
    if (values[i]!.trim())
      errors.push(`${TEXT_IMPORT_HEADERS[i]}：必须为空，题目将导入当前选择的题库`);
  }
  const type = textTypes.get(values[1]!.trim());
  if (!type) errors.push('题目类型：必须是单选文本题、多选文本题或判断题');
  const sourceDifficulty = values[2]!.trim();
  const difficulty = textDifficulties.get(sourceDifficulty) ?? sourceDifficulty;
  if (!/^[1-5]$/.test(difficulty))
    errors.push('题目难度：填写 1～5 或很容易、容易、中等、困难、很困难');
  return [
    type ?? '',
    values[3]!,
    ...values.slice(4, 10),
    '',
    '',
    values[10]!,
    values[11]!,
    difficulty,
    '',
    '',
    '',
    '',
  ];
}
// No extraction to disk. Validate actual expanded bytes, not just ZIP directory claims.
async function validateArchive(data: Buffer) {
  await new Promise<void>((resolve, reject) =>
    yauzl.fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('INVALID_WORKBOOK'));
          return;
        }
        let total = 0,
          count = 0;
        const names = new Set<string>();
        let failed = false;
        const fail = () => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(new Error('INVALID_WORKBOOK'));
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (!failed) resolve();
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          if (
            ++count > 80 ||
            entry.uncompressedSize > 8 * 1024 * 1024 ||
            entry.generalPurposeBitFlag & 1 ||
            names.has(entry.fileName)
          ) {
            fail();
            return;
          }
          names.add(entry.fileName);
          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          if (
            !/^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/[\w.-]+\.xml|xl\/(?:[\w.-]+\/)*[\w.-]+\.(?:xml|rels))$/.test(
              entry.fileName,
            ) ||
            /externalLinks|drawings|media|embeddings|vba|activeX/i.test(entry.fileName)
          ) {
            fail();
            return;
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) {
              fail();
              return;
            }
            const chunks: Buffer[] = [];
            stream.on('error', fail);
            stream.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > 12 * 1024 * 1024) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              if (failed) return;
              const xml = Buffer.concat(chunks).toString('utf8');
              if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(xml)) {
                fail();
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    ),
  );
}
export async function makeTemplate() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('题目');
  sheet.addRow(IMPORT_HEADERS);
  sheet.columns = IMPORT_HEADERS.map((h) => ({
    width: h === '题干' || h === '答案' || h === '解析' ? 36 : 18,
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const notes = book.addWorksheet('填写说明');
  for (const line of [
    'MetaExam 题目导入模板 V1；只读取“题目”工作表，不要改动标题。',
    '每次最多 500 行、文件 2 MiB。单元格只填文字或数字，不支持公式、超链接、合并单元格、嵌入图片和宏。',
    '题型填写：单选、多选、判断、填空、简答。难度填写 1～5；知识点和标签以 | 分隔。',
    '选择题选项从 A 连续填写，答案使用 A 或 A|C。多选至少两个正确答案。',
    '判断答案填写 正确 或 错误；简答答案填写参考答案。',
    '填空题干使用 [[blank]]；答案填写 JSON 二维数组，例如 [["2","二"],["4"]]，每个数组对应一空。',
    '填空区分大小写和填空忽略首尾空白填写 是 或 否，仅填空题填写。',
    '本模板不导入图片，题目入库后可在编辑页面上传。若有错误，修正后重新上传；重复题可跳过或保留。',
    '也可直接上传固定 15 列文字题库，列名和顺序如下；工作表名称不限，表头在第 1 行或空白首行后的第 2 行。工作簿只能有一张匹配的题目表。',
    TEXT_IMPORT_HEADERS.join('、'),
    '15 列格式只支持单选文本题、多选文本题、判断题；答案格式与本模板相同。题目ID、关联知识点ID、课程ID、题库ID 必须为空，导入当前选择的题库。',
    '15 列格式难度：很容易=1、容易=2、中等=3、困难=4、很困难=5，也可填写数字 1～5。知识点和标签留空。',
  ])
    notes.addRow([line]);
  notes.getColumn(1).width = 115;
  notes.eachRow((r) => {
    r.getCell(1).alignment = { wrapText: true };
    r.height = 32;
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function parseWorkbook(data: Buffer): Promise<ImportRow[]> {
  if (!data.length || data.length > 2 * 1024 * 1024) throw new Error('INVALID_WORKBOOK');
  await validateArchive(data);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data as unknown as ExcelJS.Buffer);
  const candidates: { sheet: ExcelJS.Worksheet; headerRow: number; textFormat: boolean }[] = [];
  for (const sheet of book.worksheets) {
    const matches = (headers: string[], row: number) =>
      headers.every((h, i) => sheet.getRow(row).getCell(i + 1).value === h);
    if (sheet.name === '题目' && matches(IMPORT_HEADERS, 1))
      candidates.push({ sheet, headerRow: 1, textFormat: false });
    const headerRow = sheet.getRow(1).hasValues ? 1 : 2;
    if (matches(TEXT_IMPORT_HEADERS, headerRow))
      candidates.push({ sheet, headerRow, textFormat: true });
  }
  if (candidates.length !== 1) throw new Error('INVALID_TEMPLATE');
  const { sheet, headerRow, textFormat } = candidates[0]!;
  const headers = textFormat ? TEXT_IMPORT_HEADERS : IMPORT_HEADERS;
  // WPS may retain formatting in empty columns beyond the fixed text template.
  // Check cell values, not actualColumnCount (which cannot detect sparse extra columns).
  let extraColumns = sheet.columnCount > headers.length;
  if (textFormat && extraColumns) {
    extraColumns = false;
    sheet.eachRow((row) =>
      row.eachCell((_, column) => {
        if (column > headers.length) extraColumns = true;
      }),
    );
  }
  if (
    sheet.state !== 'visible' ||
    sheet.getRow(headerRow).hidden ||
    sheet.rowCount > headerRow + 500 ||
    extraColumns ||
    Object.keys(sheet.model.merges ?? []).length
  )
    throw new Error('INVALID_WORKBOOK');
  const result: ImportRow[] = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const errors: string[] = [];
    const sourceValues = headers.map((header, i) => {
      const value = row.getCell(i + 1).value;
      if (value === null || value === undefined) return '';
      if (typeof value !== 'string' && typeof value !== 'number') {
        errors.push(`${header}：只支持文字或数字，不能使用公式或链接`);
        return '';
      }
      const str = String(value);
      if (str.length > 16000) errors.push(`${header}：内容过长`);
      return str;
    });
    const values = textFormat ? normalizeTextRow(sourceValues, errors) : sourceValues;
    if (row.hidden) errors.push('不支持隐藏的数据行');
    let question: QuestionInput | null = null;
    try {
      const types: Record<string, QuestionInput['content']['type']> = {
        单选: 'single',
        多选: 'multiple',
        判断: 'boolean',
        填空: 'blank',
        简答: 'essay',
      };
      const type = types[values[0]!.trim()];
      if (!type) throw new Error('题型必须是单选、多选、判断、填空或简答');
      const answer = values[10]!;
      let content: unknown;
      if (type === 'single' || type === 'multiple') {
        const options = values.slice(2, 10).map((text, i) => ({
          id: randomUUID(),
          text: text.trim(),
          letter: String.fromCharCode(65 + i),
        }));
        const letters = answer.trim().toUpperCase().split('|');
        if (letters.some((l) => !/^[A-H]$/.test(l) || !options.find((o) => o.letter === l)?.text))
          throw new Error('答案须用有效选项字母，以 | 分隔');
        const nonempty = options.filter((o) => o.text);
        if (options.slice(0, nonempty.length).some((o) => !o.text))
          throw new Error('选项必须从 A 开始连续填写');
        content = {
          type,
          options: nonempty.map(({ id, text }) => ({ id, text })),
          answer: letters.map((l) => options.find((o) => o.letter === l)!.id),
        };
      } else {
        if (values.slice(2, 10).some((v) => v.trim())) throw new Error('此题型不应填写选项');
        if (type === 'boolean') {
          if (!['正确', '错误'].includes(answer.trim())) throw new Error('判断答案填写正确或错误');
          content = { type, answer: answer.trim() === '正确' };
        }
        if (type === 'essay') content = { type, referenceAnswer: answer };
        if (type === 'blank') {
          const blanks = JSON.parse(answer) as unknown;
          if (!Array.isArray(blanks)) throw new Error('填空答案须为 JSON 二维数组');
          if (
            !['是', '否'].includes(values[15]!.trim()) ||
            !['是', '否'].includes(values[16]!.trim())
          )
            throw new Error('填空规则填写是或否');
          content = {
            type,
            blanks: blanks.map((answers) => ({ id: randomUUID(), answers })),
            caseSensitive: values[15]!.trim() === '是',
            trimWhitespace: values[16]!.trim() === '是',
          };
        }
      }
      if (type !== 'blank' && (values[15]!.trim() || values[16]!.trim()))
        throw new Error('非填空题不应填写填空规则');
      const split = (s: string) => (s.trim() ? s.split('|').map((v) => v.trim()) : []);
      const parsed = questionInputSchema.safeParse({
        stem: values[1],
        content,
        explanation: values[11],
        difficulty: Number(values[12]),
        knowledgePoints: split(values[13]!),
        tags: split(values[14]!),
      });
      if (!parsed.success)
        errors.push(...parsed.error.issues.map((i) => i.path.join('.') + '：' + i.message));
      else if (!errors.length) question = parsed.data;
    } catch (e) {
      errors.push(
        e instanceof SyntaxError ? '填空答案须为有效 JSON 二维数组' : (e as Error).message,
      );
    }
    result.push({
      rowNumber,
      question,
      errors: errors.slice(0, 20),
      duplicate: false,
      questionId: null,
    });
  }
  if (!result.length) throw new Error('EMPTY_WORKBOOK');
  return result;
}
export async function normalizeImage(data: Buffer) {
  if (
    !data.length ||
    data.length > 2 * 1024 * 1024 ||
    !(
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (data[0] === 255 && data[1] === 216)
    )
  )
    throw new Error('INVALID_IMAGE');
  const img = sharp(data, { limitInputPixels: 8000000, failOn: 'warning' });
  const meta = await img.metadata();
  if (!['png', 'jpeg'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1)
    throw new Error('INVALID_IMAGE');
  const { data: buffer, info } = await img.autoOrient().png().toBuffer({ resolveWithObject: true });
  if (buffer.length > 8 * 1024 * 1024) throw new Error('INVALID_IMAGE');
  return { buffer, width: info.width, height: info.height };
}
const accountHeaders = ['用户名', '姓名', '角色', '班级编码', '初始密码'];
export async function accountTemplate() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('账号');
  sheet.addRow(accountHeaders);
  for (let i = 1; i <= 5; i++) {
    sheet.getColumn(i).width = 24;
    sheet.getColumn(i).numFmt = '@';
  }
  const notes = book.addWorksheet('说明');
  notes.addRow(['角色填写学生或教师；班级须已存在且启用，教师留空班级。']);
  notes.addRow([
    '新账号填写各自初始密码（6～128 字符），首次登录强制改密；已有账号密码必须留空，姓名和角色须匹配。',
  ]);
  notes.addRow([
    '已有学生可加入班级，已存在的成员关系跳过；不覆盖账号资料。最多 500 行、2 MiB，所有单元格使用文本，不含公式或链接。',
  ]);
  notes.getColumn(1).width = 110;
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function accountWorkbook(data: Buffer): Promise<AccountImportInput[]> {
  if (!data.length || data.length > 2 * 1024 * 1024) throw new Error('INVALID_WORKBOOK');
  await validateArchive(data);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data as unknown as ExcelJS.Buffer);
  const sheet = book.getWorksheet('账号');
  if (!sheet || !accountHeaders.every((h, i) => sheet.getRow(1).getCell(i + 1).value === h))
    throw new Error('INVALID_WORKBOOK');
  if (
    sheet.state !== 'visible' ||
    sheet.rowCount > 501 ||
    sheet.columnCount > 5 ||
    sheet.getRow(1).hidden ||
    sheet.model.merges?.length
  )
    throw new Error('INVALID_WORKBOOK');
  const result: AccountImportInput[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const values = accountHeaders.map((_, i) => {
      const value = row.getCell(i + 1).value;
      if (value !== null && typeof value !== 'string') throw new Error('INVALID_WORKBOOK');
      if ((value?.length ?? 0) > 128) throw new Error('INVALID_WORKBOOK');
      return value ?? '';
    });
    if (row.hidden) throw new Error('INVALID_WORKBOOK');
    result.push({
      row: n,
      username: values[0]!.trim().toLowerCase(),
      displayName: values[1]!.trim(),
      role: (values[2] === '学生'
        ? 'student'
        : values[2] === '教师'
          ? 'teacher'
          : values[2]) as AccountImportInput['role'],
      classCode: values[3]!.trim(),
      password: values[4]!,
    });
  });
  if (!result.length) throw new Error('INVALID_WORKBOOK');
  return result;
}
if (parentPort)
  void (async () => {
    try {
      const d = workerData as { kind: string; data: Uint8Array };
      const result =
        d.kind === 'account-template'
          ? await accountTemplate()
          : d.kind === 'account-workbook'
            ? await accountWorkbook(Buffer.from(d.data))
            : d.kind === 'results'
              ? await resultWorkbook(JSON.parse(Buffer.from(d.data).toString('utf8')))
              : d.kind === 'template'
                ? await makeTemplate()
                : d.kind === 'image'
                  ? await normalizeImage(Buffer.from(d.data))
                  : await parseWorkbook(Buffer.from(d.data));
      parentPort!.postMessage({ ok: true, result });
    } catch (e) {
      const message = (e as Error).message;
      parentPort!.postMessage({
        ok: false,
        code:
          workerData.kind === 'results'
            ? 'RESULT_EXPORT_FAILED'
            : workerData.kind === 'image'
              ? 'INVALID_IMAGE'
              : ['INVALID_TEMPLATE', 'EMPTY_WORKBOOK'].includes(message)
                ? message
                : 'INVALID_WORKBOOK',
      });
    }
  })();
