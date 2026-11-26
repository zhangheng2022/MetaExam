import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { resultWorkbook } from './result-workbook';
import sharp from 'sharp';
import yauzl from 'yauzl';
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
  const sheet = book.getWorksheet('题目');
  if (
    !sheet ||
    sheet.state !== 'visible' ||
    sheet.rowCount > 501 ||
    sheet.columnCount > IMPORT_HEADERS.length ||
    Object.keys(sheet.model.merges ?? []).length
  )
    throw new Error('INVALID_WORKBOOK');
  if (IMPORT_HEADERS.some((h, i) => sheet.getRow(1).getCell(i + 1).value !== h))
    throw new Error('INVALID_TEMPLATE');
  const result: ImportRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const errors: string[] = [];
    const values = IMPORT_HEADERS.map((_, i) => {
      const value = row.getCell(i + 1).value;
      if (value === null || value === undefined) return '';
      if (typeof value !== 'string' && typeof value !== 'number') {
        errors.push(`${IMPORT_HEADERS[i]}：只支持文字或数字，不能使用公式或链接`);
        return '';
      }
      const str = String(value);
      if (str.length > 16000) errors.push(`${IMPORT_HEADERS[i]}：内容过长`);
      return str;
    });
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
if (parentPort)
  void (async () => {
    try {
      const d = workerData as { kind: string; data: Uint8Array };
      const result =
        d.kind === 'results'
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
