import test from 'node:test';
import assert from 'node:assert/strict';

import { planShadows } from '../dist/shadow-budget.js';
import { ContextGuard } from '../dist/context-guard.js';

const low = { tier: 'low', shadowQuality: 'low' };
const mid = { tier: 'mid', shadowQuality: 'low' };
const high = { tier: 'high', shadowQuality: 'high' };

test('低端档直接关阴影', () => {
  const plan = planShadows(low);
  assert.equal(plan.enabled, false);
  assert.equal(plan.near, null);
  assert.equal(plan.far, null);
  assert.match(plan.reason, /低端/);
});

test('档位写明 off 时，即使高端也关', () => {
  const plan = planShadows({ tier: 'high', shadowQuality: 'off' });
  assert.equal(plan.enabled, false);
});

test('中端只有一级，高端有近远两级', () => {
  const midPlan = planShadows(mid);
  assert.equal(midPlan.enabled, true);
  assert.equal(midPlan.near?.mapSize, 512);
  assert.equal(midPlan.far, null);

  const highPlan = planShadows(high);
  assert.equal(highPlan.near?.mapSize, 1024);
  assert.equal(highPlan.far?.mapSize, 512);
  // 近处覆盖范围必须小于远处，否则「两级」没有意义
  assert.ok((highPlan.near?.extent ?? 0) < (highPlan.far?.extent ?? 0));
});

test('DRS 吃紧时阴影减半（联动）', () => {
  const calm = planShadows(high, 1);
  const pressured = planShadows(high, 0.8);
  assert.equal(calm.near?.mapSize, 1024);
  assert.equal(pressured.near?.mapSize, 512);
  assert.equal(calm.far?.mapSize, 512);
  assert.equal(pressured.far?.mapSize, 256);

  const midCalm = planShadows(mid, 1);
  const midPressed = planShadows(mid, 0.8);
  assert.equal(midCalm.near?.mapSize, 512);
  assert.equal(midPressed.near?.mapSize, 256);
});

test('联动阈值是 0.85（卡在边界两侧要给出不同结果）', () => {
  assert.equal(planShadows(high, 0.86).near?.mapSize, 1024);
  assert.equal(planShadows(high, 0.84).near?.mapSize, 512);
});

test('reason 说明为什么关着（面板要能直接显示）', () => {
  assert.ok(planShadows(low).reason.length > 0);
  assert.ok(planShadows(high, 0.8).reason.includes('512'));
});

test('ContextGuard：丢失时 preventDefault 并回调', () => {
  const target = new EventTarget();
  let lost = 0;
  const guard = new ContextGuard(target, { onLost: () => (lost += 1) });

  const event = new Event('webglcontextlost', { cancelable: true });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, '不 preventDefault 浏览器就不会去恢复');
  assert.equal(guard.isLost, true);
  assert.equal(lost, 1);

  // 重复丢失事件不会重复回调（浏览器在恢复前可能反复报）
  target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(lost, 1);
  assert.equal(guard.stats.lost, 1);
});

test('ContextGuard：恢复走延迟调度后才解除冻结', () => {
  const target = new EventTarget();
  const calls = [];
  const guard = new ContextGuard(target, {
    onRestored: () => calls.push('restored'),
    restoreDelayMs: 16,
    // 测试里把「延迟」换成立即执行：要验的是「先调度、再恢复」这个顺序，
    // 不是计时器本身（那属于浏览器行为）
    schedule: (task) => {
      calls.push('scheduled');
      task();
    },
  });

  target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.deepEqual(calls, ['scheduled', 'restored']);
  assert.equal(guard.isLost, false);
  assert.equal(guard.stats.restored, 1);
});

test('ContextGuard：没丢失过时的 restored 事件被忽略', () => {
  const target = new EventTarget();
  let restored = 0;
  const guard = new ContextGuard(target, { onRestored: () => (restored += 1), schedule: () => {} });
  target.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(restored, 0);
});

test('ContextGuard：dispose 之后不再响应事件', () => {
  const target = new EventTarget();
  let lost = 0;
  const guard = new ContextGuard(target, { onLost: () => (lost += 1) });
  guard.dispose();
  target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(lost, 0);
  assert.equal(guard.isLost, false);
});
