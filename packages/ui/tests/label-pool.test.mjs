/**
 * 标签池测试。
 *
 * Node 里没有 DOM，所以这里用最小假对象替掉 `document.createElement`。
 * 测的不是「能不能显示」，而是**池化与差异比较有没有真的生效** ——
 * 这两点是这个类唯一的价值，破了就退化成「每帧 createElement + 每帧写样式」。
 *
 * 关键观测点是 `stats.transformWrites` / `stats.textWrites`：
 * 它们只在真的写了 DOM 时才递增，所以「没变就不写」有了可断言的证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function makeDom() {
  const created = [];
  globalThis.document = {
    createElement() {
      const el = {
        className: '',
        style: {},
        textContent: '',
        classList: {
          values: new Set(),
          toggle(name, on) {
            if (on) this.values.add(name);
            else this.values.delete(name);
          },
        },
        removed: false,
        remove() {
          this.removed = true;
        },
      };
      created.push(el);
      return el;
    },
  };
  const container = {
    children: [],
    appendChild(el) {
      this.children.push(el);
    },
  };
  return { container, created };
}

async function freshLabelPool(options) {
  // 每个测试都要重新 import 吗？不用 —— 类本身无模块级状态
  const { LabelPool } = await import('../dist/index.js');
  const { container, created } = makeDom();
  return { pool: new LabelPool(container, options), container, created };
}

function visual(overrides = {}) {
  return { x: 10, y: 20, scale: 1, visible: true, text: '住宅', ...overrides };
}

test('元素按需创建，多余的下次复用而不是重建', async () => {
  const { pool, container, created } = await freshLabelPool();
  pool.apply([visual(), visual({ x: 30 })]);
  assert.equal(created.length, 2);
  assert.equal(container.children.length, 2);

  // 缩到 1 个：不多创建，也不销毁
  pool.apply([visual()]);
  assert.equal(created.length, 2);
  assert.equal(container.children.length, 2);
  assert.equal(pool.count, 2);

  // 再涨回来：复用已有的
  pool.apply([visual(), visual({ x: 30 })]);
  assert.equal(created.length, 2);
});

test('位置没变就不写 transform（差异比较生效）', async () => {
  const { pool } = await freshLabelPool();
  pool.apply([visual()]);
  const after1 = pool.stats.transformWrites;
  assert.equal(after1, 1);

  pool.apply([visual()]);
  assert.equal(pool.stats.transformWrites, after1);

  // 亚像素抖动被 precision 截掉，也不该触发写入
  pool.apply([visual({ x: 10.02 })]);
  assert.equal(pool.stats.transformWrites, after1);

  // 真的动了才写
  pool.apply([visual({ x: 11 })]);
  assert.equal(pool.stats.transformWrites, after1 + 1);
});

test('文字没变就不碰 textContent（避免每帧丢弃文本布局）', async () => {
  const { pool } = await freshLabelPool();
  pool.apply([visual()]);
  const after1 = pool.stats.textWrites;
  assert.equal(after1, 1);

  pool.apply([visual({ x: 99 })]);
  assert.equal(pool.stats.textWrites, after1);

  pool.apply([visual({ x: 99, text: '农田' })]);
  assert.equal(pool.stats.textWrites, after1 + 1);
});

test('隐藏用 visibility 而不是 display（不触发重排）', async () => {
  const { pool, container } = await freshLabelPool();
  pool.apply([visual()]);
  const el = container.children[0];
  // 创建时先藏（避免刚插进 DOM 的那一帧闪在左上角），首次 apply 才显示
  assert.equal(el.style.visibility, '');
  assert.equal(el.style.display, undefined);

  pool.apply([visual({ visible: false })]);
  assert.equal(el.style.visibility, 'hidden');
  assert.equal(el.style.display, undefined);

  pool.apply([visual()]);
  assert.equal(el.style.visibility, '');
});

test('hideAll 把所有已创建的元素藏起来', async () => {
  const { pool, container } = await freshLabelPool();
  pool.apply([visual(), visual({ x: 40 })]);
  pool.hideAll();
  for (const el of container.children) assert.equal(el.style.visibility, 'hidden');
  // 再 apply 空数组也不该报错
  pool.apply([]);
});

test('bad 状态只在变化时切换类名', async () => {
  const { pool, container } = await freshLabelPool();
  pool.apply([visual({ bad: true })]);
  const el = container.children[0];
  assert.equal(el.classList.values.has('bad'), true);
  pool.apply([visual({ bad: false })]);
  assert.equal(el.classList.values.has('bad'), false);
});

test('自定义类名与精度都能注入', async () => {
  const { pool, container, created } = await freshLabelPool({ className: 'pin', badClassName: 'danger' });
  pool.apply([visual({ bad: true })]);
  assert.equal(created[0].className, 'pin');
  assert.equal(container.children[0].classList.values.has('danger'), true);
});

test('dispose 之后 apply 变成空操作（卸载顺序不可控）', async () => {
  const { pool, container, created } = await freshLabelPool();
  pool.apply([visual()]);
  pool.dispose();
  assert.equal(created[0].removed, true);
  assert.equal(pool.count, 0);
  // 这才是重点：调用方还在渲染循环里调 apply 也不会炸
  pool.apply([visual()]);
  assert.equal(created.length, 1);
});
