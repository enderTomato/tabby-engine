import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 公开面的变化必须是显式的。
 *
 * 这条测试的意义不是「代码能跑」，而是「有人改了对外承诺」时会被拦住。
 * 失败时不要直接 --update，先看 etc/api-surface.md 的 diff：
 * 加可选字段是安全的，改签名、删符号、改默认值都需要走大版本。
 */
test('公开 API 表面与基线一致', () => {
  const result = spawnSync('node', ['scripts/api-snapshot.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `API 表面变化：\n${result.stdout}\n${result.stderr}`);
});
