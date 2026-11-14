import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld } from '../dist/api/public.js';
import { PhysicsEventBus, ForceFieldRegistry, ConstraintRegistry } from '../dist/api/extension.js';
import { createWindForce, createLeashConstraint, createExplosionForce } from '../dist/api/presets.js';
import { WindField } from '../dist/api/public.js';

const BOUNDS = { min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 14, z: 12 } };

function makeWorld(ragdollOptions = { sleepDelay: 0 }) {
  return new PhysicsWorld({ bounds: BOUNDS, ragdoll: ragdollOptions });
}

test('公开入口与扩展入口都能独立导入', () => {
  assert.equal(typeof PhysicsWorld, 'function');
  assert.equal(typeof PhysicsEventBus, 'function');
  assert.equal(typeof createWindForce, 'function');
  // 公开入口不应泄漏插件工厂（那是 extension 的职责）
  assert.equal(typeof ForceFieldRegistry, 'function');
});

test('插件钩子按 beforeStep → afterStep 顺序执行', () => {
  const world = makeWorld();
  const calls = [];
  world.use({
    name: 'probe',
    register() {
      calls.push('register');
    },
    onBeforeStep() {
      calls.push('before');
    },
    onAfterStep() {
      calls.push('after');
    },
  });

  world.step(1 / 60);
  assert.deepEqual(calls, ['register', 'before', 'after']);
});

test('插件抛异常被隔离成 pluginError 事件，世界继续跑', () => {
  const world = makeWorld();
  const errors = [];
  world.events.on('pluginError', (e) => errors.push(e));

  world.use({
    name: 'broken',
    register() {
      throw new Error('register 炸了');
    },
  });
  world.use({
    name: 'broken-step',
    register() {},
    onBeforeStep() {
      throw new Error('step 炸了');
    },
  });

  assert.equal(errors.length, 1, 'register 抛异常应上报一次');
  assert.equal(errors[0].plugin, 'broken');

  // 仍然能正常步进
  const ragdoll = world.spawnHumanoid('r', 0, 5, 0, 1);
  const y0 = ragdoll.positions[1];
  for (let i = 0; i < 30; i += 1) world.step(1 / 60);
  assert.ok(ragdoll.positions[1] < y0, '布娃娃应该照常下落');
  assert.equal(errors[1]?.plugin, 'broken-step');
});

test('力场注册表按优先级排序，同优先级保持注册序', () => {
  const reg = new ForceFieldRegistry();
  const order = [];
  const mk = (id, p) => ({
    id,
    apply() {
      order.push(id);
    },
  });
  reg.add(mk('a', 0), 0);
  reg.add(mk('c', 10), 10);
  reg.add(mk('b', 5), 5);

  reg.apply({ bounds: BOUNDS, time: 0, ragdolls: [] }, 1 / 60);
  assert.deepEqual(order, ['c', 'b', 'a'], '高优先级应先执行');
});

test('力场重复 id 按 replace 语义覆盖而不是叠加', () => {
  const reg = new ForceFieldRegistry();
  let count = 0;
  reg.add({ id: 'dup', apply() { count += 1; } }, 0);
  reg.add({ id: 'dup', apply() { count += 10; } }, 0);
  reg.apply({ bounds: BOUNDS, time: 0, ragdolls: [] }, 1 / 60);
  assert.equal(count, 10, '旧的应被移除，只跑新的');
  assert.equal(reg.size, 1);
});

test('自定义约束：牵引约束把点拉回半径内', () => {
  const world = makeWorld();
  const ragdoll = world.spawnHumanoid('dog', 0, 6, 0, 1);
  world.addConstraint(createLeashConstraint('leash', 'dog', 0, { x: 0, y: 6, z: 0 }, 0.5));

  // 用爆炸把它轰出去
  world.addForceField(createExplosionForce('boom', { x: 0, y: 6, z: 0, radius: 12, power: 30 }));
  for (let i = 0; i < 120; i += 1) world.step(1 / 60);

  const dx = ragdoll.positions[0];
  const dy = ragdoll.positions[1] - 6;
  const dz = ragdoll.positions[2];
  const dist = Math.hypot(dx, dy, dz);
  assert.ok(dist <= 0.6, `牵引点离锚点 ${dist.toFixed(2)} 米，应被限制在 0.5 米附近`);
});

test('风力场：对布娃娃产生可观测位移', () => {
  const world = makeWorld();
  const wind = new WindField({ direction: 0, speed: 12, turbulence: 0, gustSpeed: 0, gustPeriod: 1e9 });
  world.addForceField(createWindForce('wind', wind, { strength: 3, wakeSleeping: true }), 0);
  const ragdoll = world.spawnHumanoid('r', 0, 9, 0, 1);
  const x0 = ragdoll.positions[0];
  for (let i = 0; i < 60; i += 1) world.step(1 / 60);
  assert.ok(ragdoll.positions[0] > x0 + 0.2, `风向 +X，位移只有 ${(ragdoll.positions[0] - x0).toFixed(2)} 米`);
});

test('collision 事件只在接触开始时触发，不是每帧重复', () => {
  const world = makeWorld({ sleepDelay: 0.5 });
  let collisions = 0;
  world.events.on('collision', () => {
    collisions += 1;
  });

  world.spawnHumanoid('r', 0, 3, 0, 1);
  for (let i = 0; i < 300; i += 1) world.step(1 / 60);

  // 9 个点 × 300 帧 = 2700 次接触判定；事件应远小于这个量级
  assert.ok(collisions > 0, '至少要有一次接触');
  assert.ok(collisions < 60, `300 帧产生了 ${collisions} 次碰撞事件，边沿检测没生效`);
});

test('bodySleep 事件在入睡时发一次', () => {
  const world = makeWorld({ sleepDelay: 0.5, sleepThreshold: 0.1 });
  const sleeps = [];
  world.events.on('bodySleep', (e) => sleeps.push(e.ragdollId));
  world.spawnHumanoid('sleeper', 0, 2, 0, 1);

  for (let i = 0; i < 400; i += 1) world.step(1 / 60);
  assert.deepEqual(sleeps, ['sleeper'], '只该发一次，不能每帧都发');
});

test('事件采样：超出预算的部分被计数并汇总上报', () => {
  const bus = new PhysicsEventBus();
  let received = 0;
  const dropped = [];
  bus.on('collision', () => {
    received += 1;
  });
  bus.on('eventsDropped', (e) => dropped.push(e.count));

  for (let i = 0; i < 20; i += 1) {
    bus.emitSampled('collision', { ragdollId: 'r', pointIndex: i, obstacleId: null, face: 2 }, 5);
  }
  assert.equal(received, 5, '预算 5 之内才发');
  const n = bus.resetSampling();
  assert.equal(n, 15, '应记录 15 次丢弃');
  assert.equal(dropped.length, 0, 'resetSampling 本身不发事件，由世界层发');

  // 新的一步预算重置
  bus.emitSampled('collision', { ragdollId: 'r', pointIndex: 0, obstacleId: null, face: 2 }, 5);
  assert.equal(received, 6);
});

test('off 可以在回调里安全移除自身', () => {
  const bus = new PhysicsEventBus();
  const seen = [];
  const offA = bus.on('step', () => {
    seen.push('a');
    offA();
  });
  bus.on('step', () => seen.push('b'));

  bus.emit('step', { dt: 0.016, ms: 1, sleepingRagdolls: 0 });
  bus.emit('step', { dt: 0.016, ms: 1, sleepingRagdolls: 0 });
  assert.deepEqual(seen, ['b', 'a', 'b']);
});

test('once 只触发一次', () => {
  const bus = new PhysicsEventBus();
  let n = 0;
  bus.once('bodySleep', () => {
    n += 1;
  });
  bus.emit('bodySleep', { ragdollId: 'a' });
  bus.emit('bodySleep', { ragdollId: 'b' });
  assert.equal(n, 1);
});

test('自定义约束注册表按 id 去重', () => {
  const reg = new ConstraintRegistry();
  let calls = 0;
  reg.add({ id: 'c1', solve() { calls += 1; } });
  reg.add({ id: 'c1', solve() { calls += 100; } });
  reg.solve({ bounds: BOUNDS, time: 0, ragdolls: [] });
  assert.equal(calls, 100);
  assert.equal(reg.size, 1);
});
