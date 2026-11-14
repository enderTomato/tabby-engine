/**
 * 旋钮面板测试。
 *
 * 这个类存在的理由是**不让调参面板变成假面板**，所以测试的重点不是
 * 「滑块能拖动」，而是「世界拒收时面板会不会跟着撒谎」。
 *
 * 用一个内存里的假世界（`FakeHost`）来精确控制每一层的失败：
 * 静默钳制、拒收、写成功但没生效、写完读不回来 —— 这四种在真实世界都会发生。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnobPanel, snapToStep } from '../dist/index.js';

/** 内存里的假世界。`behaviour` 决定 write 怎么应对。 */
class FakeHost {
  constructor(values, behaviour = {}) {
    this.values = { ...values };
    this.behaviour = behaviour;
    this.writes = [];
  }

  read(id) {
    if (this.behaviour.unreadable === id) return null;
    return this.values[id] ?? null;
  }

  write(id, value) {
    this.writes.push([id, value]);
    const mode = this.behaviour.mode ?? 'accept';
    if (mode === 'reject') return false;
    if (mode === 'clamp') {
      // 静默钳制：接受写入，但世界里的值被改小了
      this.values[id] = Math.min(value, this.behaviour.clampTo);
      return true;
    }
    if (mode === 'ignore') return true; // 说成功，其实没写进去
    this.values[id] = value;
    return true;
  }
}

const SPEC = {
  id: 'gain',
  label: '增益',
  min: 0,
  max: 10,
  step: 1,
  format: (v) => `${v}`,
  hint: '',
};

const FLOAT_SPEC = {
  id: 'rate',
  label: '税率',
  min: 0,
  max: 0.6,
  step: 0.01,
  format: (v) => `${Math.round(v * 100)}%`,
  hint: '',
};

test('snapToStep 吸附到格点并夹在区间内', () => {
  assert.equal(snapToStep(SPEC, 3.4), 3);
  assert.equal(snapToStep(SPEC, 3.6), 4);
  assert.equal(snapToStep(SPEC, -5), 0);
  assert.equal(snapToStep(SPEC, 99), 10);
  // 浮点 step 不该留下 0.030000000000000002
  assert.equal(snapToStep(FLOAT_SPEC, 0.03), 0.03);
  assert.equal(snapToStep(FLOAT_SPEC, 0.034), 0.03);
  assert.equal(snapToStep(FLOAT_SPEC, 0.036), 0.04);
});

test('非有限值不把面板带进 NaN', () => {
  assert.equal(snapToStep(SPEC, NaN), 0);
  assert.equal(snapToStep(SPEC, Infinity), 0);
});

test('世界读不到的旋钮干脆不显示', () => {
  const host = new FakeHost({ gain: 3 });
  const panel = new KnobPanel([SPEC, FLOAT_SPEC], host);
  assert.deepEqual(
    panel.specs.map((s) => s.id),
    ['gain'],
  );
  assert.deepEqual(panel.missing, ['rate']);
});

test('构造时不擅自吸附世界里的值', () => {
  // 世界被别处改成了 2.5，面板应照原样显示，而不是偷偷变成 3
  const host = new FakeHost({ gain: 2.5 });
  const panel = new KnobPanel([SPEC], host);
  assert.equal(panel.values.gain, 2.5);
});

test('正常写入：回读确认后用真实值更新', () => {
  const host = new FakeHost({ gain: 3 });
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('gain', 7);
  assert.equal(result.ok, true);
  assert.equal(result.actual, 7);
  assert.equal(result.reason, '');
  assert.equal(panel.values.gain, 7);
});

test('世界拒收时弹回真实值并给出原因', () => {
  const host = new FakeHost({ gain: 3 }, { mode: 'reject' });
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('gain', 7);
  assert.equal(result.ok, false);
  assert.equal(result.actual, 3);
  assert.match(result.reason, /拒收/);
  assert.equal(panel.values.gain, 3);
});

test('世界静默钳制时靠差异检测抓出来', () => {
  const host = new FakeHost({ gain: 3 }, { mode: 'clamp', clampTo: 5 });
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('gain', 9);
  assert.equal(result.ok, false);
  assert.equal(result.actual, 5);
  assert.match(result.reason, /世界是/);
});

test('write 说成功但世界没变，也要以回读为准', () => {
  const host = new FakeHost({ gain: 3 }, { mode: 'ignore' });
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('gain', 7);
  assert.equal(result.ok, false);
  assert.equal(result.actual, 3);
});

test('写完之后读不回来，报错但不抛', () => {
  const host = new FakeHost({ gain: 3 });
  const panel = new KnobPanel([SPEC], host);
  // 构造时读得到，写完之后读不到 —— 这就是「世界在写入过程中把字段搬走了」
  host.write = (id, value) => {
    host.values[id] = value;
    host.behaviour.unreadable = id;
    return true;
  };
  const result = panel.apply('gain', 9);
  assert.equal(result.ok, false);
  assert.match(result.reason, /读不回来/);
});

test('write 抛错被接住，面板不炸', () => {
  const host = new FakeHost({ gain: 3 });
  host.write = () => {
    throw new Error('boom');
  };
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('gain', 5);
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);
});

test('未知旋钮 id 拒绝而非静默通过', () => {
  const host = new FakeHost({ gain: 3 });
  const panel = new KnobPanel([SPEC], host);
  const result = panel.apply('nope', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /未知旋钮/);
  assert.deepEqual(host.writes, []);
});

test('refresh 能察觉世界被别的路径改了，并清掉旧的失败原因', () => {
  const host = new FakeHost({ gain: 3 }, { mode: 'reject' });
  const panel = new KnobPanel([SPEC], host);
  panel.apply('gain', 7);
  assert.notEqual(panel.feedback.gain, '');

  host.behaviour = {};
  host.values.gain = 8;
  assert.equal(panel.refresh(), true);
  assert.equal(panel.values.gain, 8);
  assert.equal(panel.feedback.gain, '');
  // 没变化时不返回 true，UI 不用白重渲染
  assert.equal(panel.refresh(), false);
});
