import test from 'node:test';
import assert from 'node:assert/strict';
import {
  administratorSchema,
  changePasswordSchema,
  passwordSchema,
} from '../packages/contracts/src';
import { userCreateSchema, resetPasswordSchema } from '../packages/contracts/src/management';

test('账号密码所有写入口接受六位纯数字，拒绝过短或过长密码', () => {
  const inputs = [
    (password: string) =>
      administratorSchema.safeParse({ username: 'admin', displayName: '管理员', password }),
    (password: string) =>
      changePasswordSchema.safeParse({ oldPassword: 'existing password', newPassword: password }),
    (password: string) =>
      userCreateSchema.safeParse({
        username: 'student',
        displayName: '学生',
        roles: ['student'],
        password,
      }),
    (password: string) => resetPasswordSchema.safeParse({ password, revision: 1 }),
  ];
  for (const parse of inputs) {
    for (const password of ['123456', 'abcdef', 'a'.repeat(128), 'existing long password']) {
      assert.equal(parse(password).success, true);
    }
    for (const password of ['', '12345', 'a'.repeat(129)]) {
      assert.equal(parse(password).success, false);
    }
  }
  assert.equal(passwordSchema.parse(' 123456 '), ' 123456 ', '密码原文不去空白');
});
