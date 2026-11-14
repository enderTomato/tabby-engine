import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyLod } from '../dist/lod.js';

function makeCase(count) {
  const points = new Float32Array(count * 2);
  const states = new Uint8Array(count);
  const nearIndex = new Int32Array(count);
  const farIndex = new Int32Array(count);
  return { points, states, nearIndex, farIndex };
}

const TH = { enterNear: 10, exitNear: 14, maxDistance: 100 };

test('近处的走到 near，远处走到 far', () => {
  const c = makeCase(3);
  // 0: 距原点 5；1: 距原点 30；2: 距原点 200（超出绘制距离）
  c.points.set([5, 0, 30, 0, 200, 0]);
  const split = classifyLod(c.points, c.states, 3, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.deepEqual(split, { near: 1, far: 1, culled: 1 });
  assert.equal(c.nearIndex[0], 0);
  assert.equal(c.farIndex[0], 1);
});

test('迟滞：进了近景之后要退到 exitNear 之外才变远', () => {
  const c = makeCase(1);
  c.points.set([0, 0]);

  // 12m：没进过近景，enterNear=10 进不去 → far
  c.points[0] = 12;
  let split = classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 0);

  // 9m：进入近景
  c.points[0] = 9;
  split = classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 1);

  // 回到 12m：仍在 exitNear=14 之内，保持近景（不闪）
  c.points[0] = 12;
  split = classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 1);

  // 15m：超过 exitNear，退回贴片
  c.points[0] = 15;
  split = classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 0);
});

test('边界上反复横跳不会改变结果（防闪烁）', () => {
  const c = makeCase(1);
  c.points.set([9.9, 0]);
  classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
  // 在 9~13.9 之间来回抖 200 次，状态必须一直是近景
  for (let i = 0; i < 200; i += 1) {
    c.points[0] = i % 2 === 0 ? 9 : 13.9;
    const split = classifyLod(c.points, c.states, 1, 0, 0, TH, c.nearIndex, c.farIndex);
    assert.equal(split.near, 1, `第 ${i} 次抖动后掉出了近景`);
  }
});

test('被剔除的实例不留在任何一个下标数组里', () => {
  const c = makeCase(3);
  c.points.set([1, 0, 500, 0, 2, 0]);
  const split = classifyLod(c.points, c.states, 3, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.culled, 1);
  assert.equal(split.near, 2);
  assert.equal(split.far, 0);
  // nearIndex[0..1] 必须是 0 和 2，不能混进被剔除的 1
  assert.deepEqual([c.nearIndex[0], c.nearIndex[1]], [0, 2]);
});

test('输出顺序与实例下标顺序一致（确定性）', () => {
  const c = makeCase(6);
  // 打乱远近顺序：3,0,5,1,4,2 距离递增
  const distances = [30, 20, 50, 5, 40, 8];
  for (let i = 0; i < 6; i += 1) c.points[i * 2] = distances[i];
  const split = classifyLod(c.points, c.states, 6, 0, 0, TH, c.nearIndex, c.farIndex);
  const nearIds = Array.from(c.nearIndex.subarray(0, split.near));
  const farIds = Array.from(c.farIndex.subarray(0, split.far));
  assert.deepEqual(nearIds, [3, 5]);
  assert.deepEqual(farIds, [0, 1, 2, 4]);
  // 两组都必须是升序（因为按 i 遍历）
  assert.deepEqual([...nearIds].sort((a, b) => a - b), nearIds);
  assert.deepEqual([...farIds].sort((a, b) => a - b), farIds);
});

test('相机移动只影响距离判定，不影响已分配的内存', () => {
  const c = makeCase(2);
  c.points.set([0, 0, 40, 0]);
  let split = classifyLod(c.points, c.states, 2, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 1);
  // 相机挪到 30m 处，第一个变远、第二个变近
  split = classifyLod(c.points, c.states, 2, 30, 0, TH, c.nearIndex, c.farIndex);
  assert.equal(split.near, 1);
  assert.equal(c.nearIndex[0], 1);
});

test('零实例不崩', () => {
  const c = makeCase(0);
  const split = classifyLod(c.points, c.states, 0, 0, 0, TH, c.nearIndex, c.farIndex);
  assert.deepEqual(split, { near: 0, far: 0, culled: 0 });
});
