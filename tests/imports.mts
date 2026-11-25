import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { questionFixture } from './questions-fixture.mts';
import { processOne, storedFile, AttachmentRepository } from '../packages/db/dist/index.js';
import { IMPORT_HEADERS, makeTemplate, parseWorkbook } from '../packages/db/dist/file-processor.js';
import { writeFile, readFile } from 'node:fs/promises';
const require = createRequire(path.resolve('packages/db/package.json')),
  Excel = require('exceljs'),
  sharp = require('sharp');
export async function workbook(rows: unknown[][]) {
  const b = new Excel.Workbook();
  b.addWorksheet('题目').addRows([IMPORT_HEADERS, ...rows]);
  return Buffer.from(await b.xlsx.writeBuffer());
}
export const exampleRows = [
  [
    '单选',
    '一加一等于几？',
    '2',
    '3',
    '',
    '',
    '',
    '',
    '',
    '',
    'A',
    '计算加法',
    2,
    '加法',
    '基础',
    '',
    '',
  ],
  ['多选', '选择偶数', '2', '3', '4', '', '', '', '', '', 'A|C', '', 3, '整数', '基础', '', ''],
  ['判断', '零是偶数', '', '', '', '', '', '', '', '', '正确', '', 2, '整数', '', '', ''],
  [
    '填空',
    '一加一是 [[blank]]',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '[["2","二"]]',
    '',
    2,
    '加法',
    '',
    '否',
    '是',
  ],
  [
    '简答',
    '说明你的计算步骤',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '列式后计算',
    '',
    3,
    '加法',
    '',
    '',
    '',
  ],
];
const t = await questionFixture();
try {
  const { admin, teacher, other, student } = t.people;
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  const bank = await t.create('/question-banks', {
    name: '导入库',
    courseId: t.courseId,
    visibility: 'public',
  });
  const upload = async (
    bytes: Buffer,
    image = false,
    cookie = admin!.cookie,
    target = bank,
    extra = false,
    origin?: string,
  ) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], {
        type: image
          ? 'image/png'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      image ? 'test.png' : 'test.xlsx',
    );
    if (extra) form.append('file', new Blob(['extra']), 'extra.xlsx');
    return fetch(
      base + '/api/v1/question-banks/' + target + (image ? '/attachments' : '/imports'),
      { method: 'POST', headers: { cookie, ...(origin ? { origin } : {}) }, body: form },
    );
  };
  const bytes = await workbook(exampleRows);
  assert.equal((await parseWorkbook(bytes)).length, 5);
  for (const change of [
    (s: { mergeCells: (range: string) => void }) => s.mergeCells('A2:B2'),
    (s: { getCell: (cell: string) => { value: unknown } }) => {
      s.getCell('B2').value = { text: '外部链接', hyperlink: 'https://example.com/' };
    },
  ]) {
    const b = new Excel.Workbook();
    const s = b.addWorksheet('题目');
    s.addRows([IMPORT_HEADERS, exampleRows[0]]);
    change(s);
    await assert.rejects(
      parseWorkbook(Buffer.from(await b.xlsx.writeBuffer())),
      /INVALID_WORKBOOK/,
    );
  }
  assert.equal(
    (await parseWorkbook(await workbook(Array.from({ length: 500 }, () => exampleRows[2]!))))
      .length,
    500,
  );
  await assert.rejects(
    parseWorkbook(await workbook(Array.from({ length: 501 }, () => exampleRows[2]!))),
    /INVALID_WORKBOOK/,
  );
  const template = await fetch(base + '/api/v1/question-banks/' + bank + '/import-template', {
    headers: { cookie: admin!.cookie },
  });
  assert.equal(template.status, 200);
  assert.ok((await template.arrayBuffer()).byteLength > 1000);
  await assert.rejects(parseWorkbook(await makeTemplate()), /EMPTY_WORKBOOK/);
  assert.equal((await upload(bytes, false, student!.cookie)).status, 403);
  assert.equal((await upload(bytes, false, teacher!.cookie)).status, 403);
  assert.equal(
    (await upload(bytes, false, admin!.cookie, bank, false, 'https://evil.example')).status,
    403,
  );
  assert.equal((await upload(bytes, false, admin!.cookie, bank, true)).status, 400);
  assert.equal((await upload(Buffer.alloc(2 * 1024 * 1024 + 1))).status, 400);
  const start = await upload(bytes);
  assert.equal(start.status, 202, await start.clone().text());
  const id = (await start.json()).id;
  const report = async (batch: string) =>
    (
      await t.request(`/question-banks/${bank}/imports/${batch}`, 'GET', undefined, admin!.cookie)
    ).json();
  assert.equal((await report(id)).summary.status, 'pending');
  // A claim abandoned by another worker is recovered, with no duplicate report rows.
  await t.db.pool.query(
    "UPDATE jobs SET status='running',attempts=1,lease_token=$2,lease_until=now()-interval '1 second' WHERE payload->>'importId'=$1",
    [id, randomUUID()],
  );
  assert.equal(await processOne(t.db), true);
  let r = await report(id);
  assert.equal(r.summary.status, 'ready', JSON.stringify(r));
  assert.equal(r.summary.errors, 0);
  assert.equal(r.rows.total, 5);
  assert.equal(
    (await t.request(`/question-banks/${bank}/imports/${id}`, 'GET', undefined, other!.cookie))
      .statusCode,
    404,
  );
  const confirm = (batch: string, duplicatePolicy = 'skip') =>
    t.request(
      `/question-banks/${bank}/imports/${batch}/confirm`,
      'POST',
      { duplicatePolicy },
      admin!.cookie,
    );
  assert.deepEqual(
    (await Promise.all([confirm(id), confirm(id)])).map((x) => x.statusCode),
    [202, 202],
  );
  assert.equal((await confirm(id, 'keep')).statusCode, 409);
  await processOne(t.db);
  r = await report(id);
  assert.equal(r.summary.status, 'completed');
  assert.equal(r.summary.imported, 5);
  assert.equal((await confirm(id)).statusCode, 202);
  await t.db.pool.query(
    "UPDATE jobs SET status='running',attempts=1,lease_until=now()-interval '1 second' WHERE business_key=$1",
    ['question.apply:' + id],
  );
  await processOne(t.db);
  assert.equal(
    (await t.db.pool.query('SELECT count(*) FROM questions WHERE bank_id=$1', [bank])).rows[0]
      .count,
    '5',
  );
  const second = await upload(await workbook([...exampleRows, exampleRows[0]!]));
  const id2 = (await second.json()).id;
  await processOne(t.db);
  assert.equal((await report(id2)).summary.duplicates, 6);
  await confirm(id2);
  await processOne(t.db);
  assert.equal((await report(id2)).summary.skipped, 6);
  const keep = await upload(await workbook([exampleRows[0]!]));
  const keepId = (await keep.json()).id;
  await processOne(t.db);
  await confirm(keepId, 'keep');
  await processOne(t.db);
  assert.equal((await report(keepId)).summary.imported, 1);
  const bad = await upload(
    await workbook([
      ['单选', '错误的答案', '2', '3', '', '', '', '', '', '', 'Z', '', 2, '', '', '', ''],
      [{ formula: '1+1' }, '公式', '', '', '', '', '', '', '', '', '', '', 2, '', '', '', ''],
    ]),
  );
  const badId = (await bad.json()).id;
  await processOne(t.db);
  r = await report(badId);
  assert.equal(r.summary.errors, 2);
  assert.equal((await confirm(badId)).statusCode, 409);
  const fake = await upload(Buffer.from('not a workbook'));
  const fakeId = (await fake.json()).id;
  await processOne(t.db);
  assert.equal((await report(fakeId)).summary.status, 'failed');
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#1677ff' } })
    .png()
    .toBuffer();
  const image = await upload(png, true);
  assert.equal(image.status, 201, await image.clone().text());
  const imageId = (await image.json()).id;
  const imagePath = `/api/v1/question-banks/${bank}/attachments/${imageId}/content`;
  await assert.rejects(
    new AttachmentRepository(t.db).content(teacher!.id, bank, imageId),
    /NOT_FOUND/,
  );
  assert.equal(
    (await fetch(base + imagePath, { headers: { cookie: teacher!.cookie } })).status,
    404,
    'unreferenced upload is private',
  );
  assert.equal(
    (await fetch(base + imagePath, { headers: { cookie: student!.cookie } })).status,
    403,
  );
  assert.equal((await fetch(base + imagePath)).status, 401);
  assert.equal((await upload(Buffer.from('<svg onload="alert(1)"></svg>'), true)).status, 400);
  const q = {
    stem: '带图片的题目',
    content: { type: 'boolean', answer: true },
    difficulty: 2,
    tags: [],
    knowledgePoints: [],
    explanation: '',
    images: [{ id: imageId, alt: '蓝色示意图' }],
  };
  const create = await t.request(`/question-banks/${bank}/questions`, 'POST', q, admin!.cookie);
  assert.equal(create.statusCode, 201, create.body);
  const questionId = create.json().id;
  const getImage = await fetch(base + imagePath, { headers: { cookie: teacher!.cookie } });
  assert.equal(getImage.status, 200);
  assert.equal(getImage.headers.get('content-type'), 'image/png');
  assert.equal(getImage.headers.get('cache-control'), 'no-store');
  assert.equal((await sharp(Buffer.from(await getImage.arrayBuffer())).metadata()).format, 'png');
  const outside = await t.create('/question-banks', {
    name: '另一题库',
    courseId: t.courseId,
    visibility: 'public',
  });
  assert.equal(
    (await t.request(`/question-banks/${outside}/questions`, 'POST', q, admin!.cookie)).statusCode,
    400,
  );
  assert.equal(
    (
      await t.request(
        `/question-banks/${bank}/questions/${questionId}`,
        'PATCH',
        { revision: 1, question: { ...q, images: [] } },
        admin!.cookie,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await fetch(base + imagePath, { headers: { cookie: teacher!.cookie } })).status,
    200,
    'old version retains attachment',
  );
  await assert.rejects(
    t.db.pool.query('DELETE FROM question_version_attachments WHERE attachment_id=$1', [imageId]),
    /IMMUTABLE/,
  );
  const file = storedFile(t.db, 'images', imageId),
    original = await readFile(file);
  await writeFile(file, 'tamper');
  assert.equal((await fetch(base + imagePath, { headers: { cookie: admin!.cookie } })).status, 503);
  await writeFile(file, original);
  const expired = await upload(bytes);
  const exp = (await expired.json()).id;
  await processOne(t.db);
  await t.db.pool.query(
    "UPDATE question_imports SET expires_at=now()-interval '1 second' WHERE id=$1",
    [exp],
  );
  assert.equal((await confirm(exp)).statusCode, 409);
  // Failure during the second insert rolls the complete import back; lease recovery retries once.
  const atomic = await upload(bytes);
  const atomicId = (await atomic.json()).id;
  await processOne(t.db);
  await confirm(atomicId, 'keep');
  const before = Number((await t.db.pool.query('SELECT count(*) FROM questions')).rows[0].count);
  await t.db.pool.query(
    `CREATE FUNCTION reject_test_question() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content->>'stem'='零是偶数' THEN RAISE EXCEPTION 'TEST_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_test BEFORE INSERT ON question_versions FOR EACH ROW EXECUTE FUNCTION reject_test_question()`,
  );
  await assert.rejects(processOne(t.db), /TEST_FAILURE/);
  assert.equal(
    Number((await t.db.pool.query('SELECT count(*) FROM questions')).rows[0].count),
    before,
  );
  await t.db.pool.query(
    'DROP TRIGGER reject_test ON question_versions; DROP FUNCTION reject_test_question()',
  );
  await processOne(t.db);
  assert.equal((await report(atomicId)).summary.imported, 5);
  assert.ok(
    !JSON.stringify(
      (
        await t.db.pool.query(
          "SELECT details FROM audit_events WHERE event LIKE 'question-import.%'",
        )
      ).rows,
    ).includes('一加一'),
  );
  await t.restart();
  assert.equal((await report(atomicId)).summary.status, 'completed');
  const privateBank = await t.request(
    '/question-banks',
    'POST',
    { name: '教师导入库', courseId: t.courseId, visibility: 'private' },
    teacher!.cookie,
  );
  assert.equal(privateBank.statusCode, 201);
  // Upload using the restarted API address, then remove teaching scope before execution.
  const privateId = privateBank.json().id;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), 'revoked.xlsx');
  const pending = await fetch(
    'http://127.0.0.1:' +
      t.app.getHttpServer().address().port +
      '/api/v1/question-banks/' +
      privateId +
      '/imports',
    { method: 'POST', headers: { cookie: teacher!.cookie }, body: form },
  );
  assert.equal(pending.status, 202);
  const pendingId = (await pending.json()).id;
  await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1', [teacher!.id]);
  await processOne(t.db);
  assert.equal(
    (await t.db.pool.query('SELECT status FROM question_imports WHERE id=$1', [pendingId])).rows[0]
      .status,
    'failed',
  );
  assert.equal(
    (await t.db.pool.query('SELECT count(*) FROM questions WHERE bank_id=$1', [privateId])).rows[0]
      .count,
    '0',
  );
  console.log(
    'PASS template, multipart limits/CSRF, five-type preflight, duplicate policy, idempotent/recoverable atomic import, file scope, image normalization/history/integrity and restart',
  );
} finally {
  await t.close();
}
