import test from 'node:test';
import assert from 'node:assert/strict';

import { DynamicResolution } from '../dist/drs.js';

/**
 * 构造一个「稳定帧时间」的序列喂进去。
 *
 * 关键点：DRS 有三个防抖（中位数 / 迟滞 / 冷却），所以测试不能只喂两帧就断言，
 * 必须按真实时间线走 —— 否则测的是实现细节，不是行为。
 */
function feed(drs, frameMs, nowMs, count) {
  let changed = 0;
  for (let i = 0; i < count; i += 1) {
    if (drs.push(frameMs, nowMs + i * 16)) changed += 1;
  }
  return changed;
}

test('稳定在目标帧时间时不动', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7 });
  let t = 0;
  let changed = 0;
  for (let i = 0; i < 600; i += 1) {
    t += 16;
    if (drs.push(16.5, t)) changed += 1;
  }
  assert.equal(changed, 0);
  assert.equal(drs.scale, 1);
});

test('持续掉帧会降分辨率，且一次只降一档', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7, step: 0.05 });
  const changed = feed(drs, 40, 0, 200);
  assert.ok(changed >= 1, '应该至少调过一次');
  assert.ok(drs.scale < 1);
  // 冷却 1.5s，200 帧 ≈ 3.2s，最多两次调整
  assert.ok(changed <= 3, `调得太频繁：${changed}`);
});

test('不会跌破 minScale', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7, minScale: 0.75, cooldownMs: 0 });
  let t = 0;
  for (let i = 0; i < 5000; i += 1) {
    t += 16;
    drs.push(120, t);
  }
  assert.equal(drs.scale, 0.75);
});

test('帧时间回到正常后会升回去，但不会超过 maxScale', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7, cooldownMs: 0, step: 0.1 });
  let t = 0;
  for (let i = 0; i < 120; i += 1) {
    t += 16;
    drs.push(60, t);
  }
  const low = drs.scale;
  assert.ok(low < 1);
  for (let i = 0; i < 600; i += 1) {
    t += 16;
    drs.push(10, t);
  }
  assert.ok(drs.scale > low);
  assert.ok(drs.scale <= 1);
});

test('迟滞区里不动（关键防抖）', () => {
  // 目标 16.7：降档阈值 1.15× = 19.2，升档阈值 0.85× = 14.2
  // 喂 18ms —— 介于两者之间，应该一直不动
  const drs = new DynamicResolution({ targetFrameMs: 16.7, cooldownMs: 0 });
  let t = 0;
  let changed = 0;
  for (let i = 0; i < 400; i += 1) {
    t += 16;
    if (drs.push(18, t)) changed += 1;
  }
  assert.equal(changed, 0);
  assert.equal(drs.scale, 1);
});

test('单帧尖刺不会触发降档（中位数 vs 平均值的差别）', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7 });
  let t = 0;
  let changed = 0;
  for (let i = 0; i < 400; i += 1) {
    t += 16;
    // 每 10 帧一次 200ms 的卡顿：平均值会爆表，中位数不会
    const frameMs = i % 10 === 0 ? 200 : 16;
    if (drs.push(frameMs, t)) changed += 1;
  }
  assert.equal(changed, 0);
});

test('切后台回来的超大帧时间被丢弃', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7 });
  assert.equal(drs.push(5000, 100), false);
  assert.equal(drs.push(Number.NaN, 200), false);
  assert.equal(drs.push(-3, 300), false);
  assert.equal(drs.state.samples, 0);
});

test('样本不够时不评估', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7, minSamples: 30 });
  let t = 0;
  let changed = 0;
  for (let i = 0; i < 20; i += 1) {
    t += 16;
    if (drs.push(100, t)) changed += 1;
  }
  assert.equal(changed, 0);
  assert.equal(drs.state.medianFrameMs, 0);
});

test('reset 清掉旧场景的样本', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7 });
  let t = 0;
  for (let i = 0; i < 100; i += 1) {
    t += 16;
    drs.push(30, t);
  }
  assert.ok(drs.state.samples > 0);
  drs.reset(0.9);
  assert.equal(drs.state.samples, 0);
  assert.equal(drs.scale, 0.9);
});

test('scale 是两位小数（0.05 累加不产生 0.7499999）', () => {
  const drs = new DynamicResolution({ targetFrameMs: 16.7, minScale: 0.7, cooldownMs: 0, step: 0.05 });
  let t = 0;
  for (let i = 0; i < 3000; i += 1) {
    t += 16;
    drs.push(90, t);
  }
  assert.equal(drs.scale, 0.7);
  assert.equal(String(drs.scale).length <= 4, true, `出现了浮点脏值：${drs.scale}`);
});
