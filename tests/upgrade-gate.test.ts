import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { upgradePending } from '../packages/db/src/maintenance-gate';

test('upgrade gate opens only when its marker is absent, not when access fails', () => {
  const stat = mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  try {
    assert.equal(upgradePending('C:/MetaExam-test/runtime'), true);
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
      stat.mock.mockImplementation(() => {
        throw Object.assign(new Error('filesystem failure'), { code });
      });
      assert.equal(upgradePending('C:/MetaExam-test/runtime'), true, code);
    }
    stat.mock.mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    });
    assert.equal(upgradePending('C:/MetaExam-test/runtime'), false);
  } finally {
    stat.mock.restore();
  }
});
