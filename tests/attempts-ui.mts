import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { attemptFixture } from './attempts-fixture.mts';
const t = await attemptFixture();
let browser;
mkdirSync('artifacts/m2-attempts', { recursive: true });
try {
  await t.open();
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  try {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill('student');
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('menuitem', { name: '我的考试' }).click();
    await page.getByRole('button', { name: '进入考试', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '进入考试', exact: true }).click();
    await page.getByText('你的答案', { exact: true }).waitFor();
    const instructions = page.getByRole('region', { name: '作答说明', exact: true });
    assert.ok((await instructions.innerText()).includes(t.instructions));
    assert.equal(await instructions.locator('b').count(), 0);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    await page.getByRole('radio', { name: '错误', exact: true }).check();
    await page.getByText(/已保存 ·/).waitFor();
    await page.reload();
    await page.getByRole('radio', { name: '错误', exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: '错误', exact: true }).isChecked(), true);
    assert.ok((await instructions.innerText()).includes(t.instructions));
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await page.getByRole('radio', { name: '选项甲', exact: true }).check();
    await page.getByText(/已保存 ·/).waitFor();
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await page.getByRole('checkbox', { name: '选项甲', exact: true }).check();
    await page.getByRole('checkbox', { name: '选项乙', exact: true }).check();
    await page.getByText(/已保存 ·/).waitFor();
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await page.getByLabel('第 1 空', { exact: true }).fill('我的填空');
    await page.getByText(/已保存 ·/).waitFor();
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await page.getByLabel('简答题答案', { exact: true }).waitFor();
    await page.getByRole('img', { name: '作答示意图' }).waitFor();
    assert.ok(
      await page
        .getByRole('img', { name: '作答示意图' })
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    );
    const saveUrl = base + '/api/v1/attempts/' + id + '/questions/5';
    await page.route(saveUrl, async (route) =>
      route.request().method() === 'PUT' ? route.abort() : route.continue(),
    );
    await page.getByLabel('简答题答案', { exact: true }).fill('断网时保留的输入');
    await page.getByText('服务连接失败，请检查后台服务后重试。', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('简答题答案', { exact: true }).inputValue(),
      '断网时保留的输入',
    );
    await page.unroute(saveUrl);
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await page.getByText(/已保存 ·/).waitFor();
    // Another browser revision wins. Current browser must not overwrite it.
    const latest = (
      await t.request(
        '/attempts/' + id + '/questions/5',
        'GET',
        undefined,
        t.people.student!.cookie,
      )
    ).json();
    await t.request(
      '/attempts/' + id + '/questions/5',
      'PUT',
      {
        revision: latest.revision,
        mutationId: randomUUID(),
        answer: { type: 'essay', text: '另一页面保存' },
      },
      t.people.student!.cookie,
    );
    await page.getByLabel('简答题答案', { exact: true }).fill('本页冲突输入');
    await page
      .getByText('答案已在其他页面更新，请重新读取后检查，不能覆盖旧版本', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByLabel('简答题答案', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('简答题答案', { exact: true }).inputValue(), '另一页面保存');
    assert.ok(!(await page.locator('body').innerText()).includes('秘密'));
    await page.screenshot({ path: 'artifacts/m2-attempts/answer-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-attempts/answer-mobile.png', fullPage: true });
    await page.getByRole('button', { name: /^交\s*卷$/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认交卷', exact: true }).click();
    await page.getByText('交卷成功', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('简答题答案').count(), 0);
    await page.reload();
    await page.getByText('交卷成功', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-attempts/receipt-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-attempts/browser-results.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            'admission',
            'frozen instructions: plaintext + refresh',
            'five question types',
            'autosave+refresh',
            'safe image',
            'offline retry',
            'other-tab conflict',
            'mobile',
            'submit+receipt',
            'no external assets/answer leaks',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS browser admission/five types/autosave/refresh/offline retry/conflict/images/mobile/receipt',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-attempts/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-attempts/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
