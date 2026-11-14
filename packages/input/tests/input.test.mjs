import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GestureRecognizer,
  MIN_TOUCH_TARGET,
  OrbitDriver,
  expandHitArea,
  gridHitAreas,
  hitTest,
  normalizeAngle,
  normalizeWheel,
  VIBRATE_MIN_INTERVAL_MS,
} from '../dist/index.js';

/**
 * 用假时钟驱动的手势夹具。
 *
 * 时间的唯一来源是 `now`，所以「长按 500ms 触发」这种断言不是等出来的，是**算**出来的 ——
 * 整个文件跑完不到 50ms，也不会有 flaky。
 */
function makeRecognizer(options = {}) {
  const events = [];
  let now = 0;
  const rec = new GestureRecognizer((event) => events.push(event), options);
  const mod = (phase, x, y, extra = {}) => {
    const sample = {
      id: extra.id ?? 1,
      x,
      y,
      t: (now += extra.dt ?? 16),
      pointerType: extra.pointerType ?? 'touch',
      pressure: 0.5,
    };
    if (phase === 'down') rec.down(sample);
    else if (phase === 'move') rec.move(sample);
    else if (phase === 'up') rec.up(sample);
    else if (phase === 'cancel') rec.cancel(sample);
    return rec;
  };
  return {
    rec,
    events,
    down: (x, y, extra) => mod('down', x, y, extra),
    move: (x, y, extra) => mod('move', x, y, extra),
    up: (x, y, extra) => mod('up', x, y, extra),
    cancel: (x, y, extra) => mod('cancel', x, y, extra),
    tick: (advance = 16) => {
      now += advance;
      rec.tick(now);
      return now;
    },
    get now() {
      return now;
    },
    kinds: () => events.map((e) => e.kind),
    last: (kind) => [...events].reverse().find((e) => e.kind === kind),
  };
}

test('点击：位移在阈值内、时长够短 → tap', () => {
  const h = makeRecognizer();
  h.down(100, 100);
  h.move(103, 102);
  h.up(104, 101);
  assert.deepEqual(h.kinds(), ['down', 'move', 'up', 'tap']);
  const tap = h.last('tap');
  assert.equal(tap.data.x, 104);
  assert.equal(tap.data.pointerType, 'touch');
});

test('点击：移动超过阈值不算点击', () => {
  const h = makeRecognizer();
  h.down(100, 100);
  h.move(100, 140); // 40px
  h.up(100, 140);
  assert.ok(!h.kinds().includes('tap'), '拖出 40px 不该判成点击');
});

test('拖拽：超过拖拽阈值发 dragstart，只发一次', () => {
  const h = makeRecognizer();
  h.down(100, 100);
  h.move(101, 100); // 1px，未达阈值
  h.move(110, 100); // 10px，触发
  h.move(130, 100);
  h.up(130, 100);
  const starts = h.kinds().filter((k) => k === 'dragstart');
  assert.equal(starts.length, 1, 'dragstart 必须只发一次');
  const drags = h.events.filter((e) => e.kind === 'drag');
  assert.equal(drags.length, 2, '触发之后的每次 move 都发 drag');
  const start = h.last('dragstart');
  assert.equal(start.data.startX, 100);
  assert.equal(start.data.totalX, 10);
  assert.ok(h.last('dragend') !== undefined, '抬手必须有 dragend，否则宿主状态卡死');
});

test('拖拽：速度按窗口估算，方向正确', () => {
  const h = makeRecognizer();
  h.down(0, 0, { dt: 10 });
  h.move(10, 0, { dt: 10 });
  h.move(30, 0, { dt: 10 });
  const drag = h.last('drag');
  assert.ok(drag.data.vx > 0.5, `向右拖速度应为正，实际 ${drag.data.vx}`);
  assert.equal(Math.round(drag.data.vy), 0);
});

test('长按：tick 推进到阈值才触发，且只触发一次', () => {
  const h = makeRecognizer({ longPressMs: 500 });
  h.down(50, 50);
  h.tick(200);
  assert.ok(!h.kinds().includes('longpress'), '200ms 不该触发');
  h.tick(400); // 累计 600
  assert.equal(h.kinds().filter((k) => k === 'longpress').length, 1);
  h.tick(200);
  assert.equal(h.kinds().filter((k) => k === 'longpress').length, 1, '不能重复触发');
  h.up(50, 50);
  assert.ok(!h.kinds().includes('tap'), '长按之后抬手不该再算点击');
});

test('长按：手指抖动超过容差就不算长按', () => {
  const h = makeRecognizer({ longPressMs: 500 });
  h.down(50, 50);
  h.move(50, 70); // 抖了 20px，超过 8px 容差
  h.tick(600);
  assert.ok(!h.kinds().includes('longpress'));
});

test('双击：间隔在窗口内 → doubletap，且默认先发了一次 tap', () => {
  const h = makeRecognizer({ doubleTapMs: 300 });
  h.down(10, 10, { dt: 10 });
  h.up(10, 10, { dt: 20 });
  h.down(11, 11, { dt: 50 });
  h.up(11, 11, { dt: 20 });
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 1, '默认模式立刻发 tap');
  const dbl = h.last('doubletap');
  assert.ok(dbl !== undefined);
  assert.equal(dbl.data.interval, 70);
});

test('双击：延迟模式只发 doubletap，不发 tap', () => {
  const h = makeRecognizer({ doubleTapMs: 300, delayTapForDouble: true });
  h.down(10, 10, { dt: 10 });
  h.up(10, 10, { dt: 20 });
  h.down(11, 11, { dt: 50 });
  h.up(11, 11, { dt: 20 });
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 0, '延迟模式下不该先发 tap');
  assert.ok(h.last('doubletap') !== undefined);
});

test('双击：超时后延迟模式的 tap 会补发，且只发一次', () => {
  const h = makeRecognizer({ doubleTapMs: 300, delayTapForDouble: true });
  h.down(10, 10, { dt: 10 });
  h.up(10, 10, { dt: 20 });
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 0);
  h.tick(400);
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 1);
  h.tick(400);
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 1, '超时补发只该发生一次');
});

test('双击：间隔过长算两次单击', () => {
  const h = makeRecognizer({ doubleTapMs: 300 });
  h.down(10, 10, { dt: 10 });
  h.up(10, 10, { dt: 20 });
  h.tick(500); // 超过窗口
  h.down(10, 10, { dt: 10 });
  h.up(10, 10, { dt: 20 });
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 2);
  assert.equal(h.kinds().filter((k) => k === 'doubletap').length, 0);
});

test('取消：pointercancel 不发 tap 也不留拖拽状态', () => {
  const h = makeRecognizer();
  h.down(10, 10);
  h.move(40, 10);
  h.cancel(40, 10);
  assert.ok(!h.kinds().includes('tap'), '系统手势取消不该算点击');
  assert.equal(h.rec.activePointers, 0, '取消后不能留下幽灵手指');
  assert.equal(h.rec.isDragging, false);
});

test('双指：pinch / rotate / pan2 同时发，不互斥', () => {
  const h = makeRecognizer();
  h.down(100, 100, { id: 1, dt: 10 });
  h.down(200, 100, { id: 2, dt: 10 });
  assert.ok(h.kinds().includes('pinchstart'));

  // 两指张开到 200 且上移 20、转一点角度
  h.move(50, 80, { id: 1, dt: 16 });
  const pinch = h.last('pinch');
  const rotate = h.last('rotate');
  const pan = h.last('pan2');
  assert.ok(pinch !== undefined, '应当发 pinch');
  assert.ok(rotate !== undefined, '应当发 rotate');
  assert.ok(pan !== undefined, '应当发 pan2');
  assert.ok(pinch.data.distance > 100, `间距应变大，实际 ${pinch.data.distance}`);
});

test('双指：scale 相对起始间距，不累乘漂移', () => {
  const h = makeRecognizer();
  h.down(100, 100, { id: 1, dt: 10 });
  h.down(200, 100, { id: 2, dt: 10 }); // 间距 100
  h.move(150, 100, { id: 1, dt: 16 }); // 间距 50
  h.move(100, 100, { id: 1, dt: 16 }); // 回到 100
  const last = h.last('pinch');
  assert.ok(Math.abs(last.data.scale - 1) < 1e-6, `回到原间距 scale 应为 1，实际 ${last.data.scale}`);
});

test('双指：抬起一指后回到单指，且发 pinchend', () => {
  const h = makeRecognizer();
  h.down(100, 100, { id: 1, dt: 10 });
  h.down(200, 100, { id: 2, dt: 10 });
  h.up(200, 100, { id: 2, dt: 20 });
  assert.ok(h.kinds().includes('pinchend'));
  assert.equal(h.rec.activePointers, 1);
});

test('双指：第二指按下时不把第一指补发成 tap', () => {
  const h = makeRecognizer();
  h.down(100, 100, { id: 1, dt: 10 });
  h.down(200, 100, { id: 2, dt: 20 });
  h.up(200, 100, { id: 2, dt: 20 });
  h.up(100, 100, { id: 1, dt: 20 });
  assert.equal(h.kinds().filter((k) => k === 'tap').length, 0, '捏合不该误触点击');
});

test('滚轮：三种 deltaMode 归一化到像素', () => {
  assert.deepEqual(normalizeWheel(0, 3, 0), { deltaX: 0, deltaY: 3 });
  assert.deepEqual(normalizeWheel(0, 3, 1), { deltaX: 0, deltaY: 48 }, '按行 → ×16');
  assert.deepEqual(normalizeWheel(0, 2, 2), { deltaX: 0, deltaY: 200 }, '按页 → ×100');
});

test('角度归一化：跨 ±π 不会算成 350 度', () => {
  assert.ok(Math.abs(normalizeAngle(Math.PI * 2 - 0.1)) < 0.11);
  // -2π+0.1 等价于 +0.1：折到 (-π, π] 之后符号应当是正的
  assert.ok(Math.abs(normalizeAngle(-Math.PI * 2 + 0.1) - 0.1) < 1e-9);
  assert.equal(normalizeAngle(0.5), 0.5);
});

test('热区：小于 44px 会向外扩，中心不变', () => {
  const tiny = { id: 'icon', x: 100, y: 100, width: 20, height: 20 };
  const expanded = expandHitArea(tiny);
  assert.equal(expanded.width, MIN_TOUCH_TARGET);
  assert.equal(expanded.height, MIN_TOUCH_TARGET);
  assert.equal(expanded.x + expanded.width / 2, tiny.x + tiny.width / 2);
  assert.equal(expanded.y + expanded.height / 2, tiny.y + tiny.height / 2);
});

test('热区：声明 expandable:false 的格子在原地不动', () => {
  const cell = { id: 'c', x: 0, y: 0, width: 20, height: 20, expandable: false };
  assert.equal(expandHitArea(cell), cell, '格子不能扩，否则会盖住隔壁');
});

test('热区：重叠时取 z 大的，同 z 取后声明的', () => {
  const areas = [
    { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', x: 0, y: 0, width: 100, height: 100, z: 2 },
    { id: 'c', x: 0, y: 0, width: 100, height: 100, z: 2 },
  ];
  assert.equal(hitTest(areas, 50, 50).id, 'c');
  assert.equal(hitTest(areas, 500, 500), null);
});

test('热区：44px 扩展后边缘可点（DPR 取整问题）', () => {
  const tiny = [{ id: 'btn', x: 100, y: 100, width: 20, height: 20 }];
  assert.equal(hitTest(tiny, 100, 100).id, 'btn', '原角落应可点');
  assert.equal(hitTest(tiny, 88, 88).id, 'btn', '扩展出去的 12px 也应可点');
  assert.equal(hitTest(tiny, 80, 80), null, '扩到 44 就不再往外');
});

test('热区：网格不重叠，边界归属右侧格子', () => {
  const areas = gridHitAreas(2, 2, 50, 50);
  assert.equal(areas.length, 4);
  assert.equal(hitTest(areas, 49, 10).id, 'cell-0-0');
  assert.equal(hitTest(areas, 51, 10).id, 'cell-1-0');
});

test('轨道：拖拽改变角度，且被 phi 上下界钳住', () => {
  const driver = new OrbitDriver({ theta: 0, phi: 1.0, distance: 20 });
  driver.drag(100, 0);
  assert.ok(driver.state.theta < 0, '向右拖应让 theta 减小');
  driver.drag(0, 100000);
  assert.ok(driver.state.phi >= 0.25, `phi 不能越过下界，实际 ${driver.state.phi}`);
});

test('轨道：惯性按帧率无关的指数衰减', () => {
  const make = () => new OrbitDriver({ theta: 0, phi: 1.0, distance: 20, damping: 0.004 });
  const a = make();
  const b = make();
  a.release(2, 0);
  b.release(2, 0);

  // 60fps：16 帧 ≈ 266ms
  for (let i = 0; i < 16; i += 1) a.update(16.67);
  // 30fps：8 帧 ≈ 266ms
  for (let i = 0; i < 8; i += 1) b.update(33.33);

  assert.ok(Math.abs(a.state.theta - b.state.theta) < 0.01, `30fps 与 60fps 的惯性位移应一致：${a.state.theta} vs ${b.state.theta}`);
});

test('轨道：惯性最终停下，且 stop() 立即停', () => {
  const driver = new OrbitDriver({ theta: 0, phi: 1.0 });
  driver.release(3, 0);
  let frames = 0;
  while (driver.update(16) && frames < 1000) frames += 1;
  assert.ok(frames < 300, `应在 300 帧内停下，实际 ${frames}`);

  const quick = new OrbitDriver({ theta: 0 });
  quick.release(3, 0);
  quick.stop();
  assert.equal(quick.update(16), false);
});

test('轨道：捏合用比值不漂移', () => {
  const driver = new OrbitDriver({ distance: 24, minDistance: 8, maxDistance: 60 });
  driver.pinch(2, 24);
  assert.equal(driver.state.distance, 12);
  driver.pinch(1, 24); // 回到起始比值
  assert.equal(driver.state.distance, 24, '回到原比值必须回到原距离，不能累乘');
});

test('轨道：缩放被上下界钳住', () => {
  const driver = new OrbitDriver({ distance: 24, minDistance: 8, maxDistance: 60 });
  driver.pinch(0.001, 24);
  assert.equal(driver.state.distance, 60);
  driver.pinch(1000, 24);
  assert.equal(driver.state.distance, 8);
});

test('轨道：eye() 与角度一致（phi=0 时在正上方）', () => {
  const driver = new OrbitDriver({ theta: 0, phi: 0.001, distance: 10, minPhi: 0 });
  const eye = driver.eye();
  assert.ok(Math.abs(eye.y - 10) < 0.01);
  assert.ok(Math.abs(eye.x) < 0.01);
});

test('触感：无 navigator.vibrate 时一律返回 false 且不抛错', async () => {
  // Node 里没有 navigator.vibrate，正好走「不支持」分支
  const { Haptics } = await import('../dist/index.js');
  const haptics = new Haptics();
  assert.equal(haptics.isSupported, false);
  assert.equal(haptics.vibrate(), false);
  assert.equal(haptics.pattern([10, 20, 10]), false);
  assert.equal(haptics.report().attempts, 0, '不支持时不该计入尝试次数');
});

test('触感：支持时按最小间隔节流', async () => {
  const { Haptics } = await import('../dist/index.js');
  const calls = [];
  // Node 22 自带一个只读的 navigator，只能给它加属性，不能整体替换
  const vibrate = (v) => {
    calls.push(v);
    return true;
  };
  Object.defineProperty(globalThis.navigator ?? {}, 'vibrate', { value: vibrate, configurable: true });
  if (typeof globalThis.navigator?.vibrate !== 'function') {
    Object.defineProperty(globalThis, 'navigator', { value: { vibrate }, configurable: true });
  }
  let clock = 0;
  const haptics = new Haptics({ now: () => clock });
  assert.equal(haptics.isSupported, true);

  assert.equal(haptics.tick(), true);
  clock += VIBRATE_MIN_INTERVAL_MS - 1;
  assert.equal(haptics.tick(), false, '间隔不足应被节流');
  clock += 2;
  assert.equal(haptics.tick(), true);

  const report = haptics.report();
  assert.equal(report.attempts, 3);
  assert.equal(report.accepted, 2);
  assert.equal(report.throttled, 1);
  assert.deepEqual(calls, [8, 8]);

  // 关掉之后不再下发
  haptics.setEnabled(false);
  clock += 1000;
  assert.equal(haptics.tick(), false);
  assert.equal(calls.length, 2);
  if (globalThis.navigator !== undefined) delete globalThis.navigator.vibrate;
});
