/**
 * Toast 队列测试。
 *
 * 时间全部用注入的假时钟推进，不依赖真实等待 —— 否则这套测试会
 * 「大部分时间在 sleep，还偶尔因为 CI 卡顿而假失败」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ToastQueue } from '../dist/index.js';

function makeQueue(options = {}) {
  const clock = { t: 0 };
  const queue = new ToastQueue({ ttlMs: 100, max: 3, now: () => clock.t, ...options });
  return { queue, clock };
}

test('空队列 peek 返回 null', () => {
  const { queue } = makeQueue();
  assert.equal(queue.peek(), null);
  assert.equal(queue.remaining(), 0);
});

test('入队后立即可读，到期自动让位给下一条', () => {
  const { queue, clock } = makeQueue();
  queue.push('A');
  queue.push('B');
  assert.equal(queue.peek(), 'A');

  clock.t = 99;
  assert.equal(queue.peek(), 'A');

  clock.t = 100;
  assert.equal(queue.peek(), 'B');
  // B 从 A 过期的那一刻开始计时，而不是从入队那一刻
  clock.t = 199;
  assert.equal(queue.peek(), 'B');
  clock.t = 200;
  assert.equal(queue.peek(), null);
});

test('同一句话连续入队只续命，不刷屏', () => {
  const { queue, clock } = makeQueue();
  queue.push('已建造住宅');
  clock.t = 80;
  queue.push('已建造住宅');
  assert.equal(queue.size, 1);
  // 续命之后 100ms 内还在
  clock.t = 170;
  assert.equal(queue.peek(), '已建造住宅');
  clock.t = 181;
  assert.equal(queue.peek(), null);
});

test('不同内容正常排队', () => {
  const { queue } = makeQueue();
  queue.push('A');
  queue.push('B');
  queue.push('C');
  assert.equal(queue.size, 3);
});

test('超过上限丢最旧的，而不是无限堆积', () => {
  const { queue } = makeQueue();
  for (const text of ['1', '2', '3', '4', '5']) queue.push(text);
  assert.equal(queue.size, 3);
  assert.equal(queue.peek(), '3');
});

test('prune 只在真变化时返回 true（UI 据此决定要不要写 ref）', () => {
  const { queue, clock } = makeQueue();
  queue.push('A');
  assert.equal(queue.prune(), false);
  clock.t = 100;
  assert.equal(queue.prune(), true);
  assert.equal(queue.prune(), false);
});

test('空字符串被忽略', () => {
  const { queue } = makeQueue();
  queue.push('');
  assert.equal(queue.size, 0);
});

test('remaining 随真实时钟递减，到 0 就过期', () => {
  const { queue, clock } = makeQueue();
  queue.push('A');
  assert.equal(queue.remaining(), 100);
  clock.t = 40;
  assert.equal(queue.remaining(), 60);
  clock.t = 500;
  assert.equal(queue.remaining(), 0);
});

test('clear 清空队列', () => {
  const { queue } = makeQueue();
  queue.push('A');
  queue.push('B');
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.peek(), null);
});
