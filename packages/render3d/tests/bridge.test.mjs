import test from 'node:test';
import assert from 'node:assert/strict';

import { RenderBridge, multiplyMatrix, projectPoint, rayBoxHit } from '../dist/bridge.js';

/**
 * 造一个「在 (0,0,dist) 朝 -z 看」的相机矩阵。
 *
 * 这里自己拼矩阵而不是用 three：bridge 模块本身不依赖 three，
 * 测试如果引 three 就等于把「能不能在纯 Node 里测」这个设计目标废掉了。
 */
function makeCamera({ dist = 10, fov = Math.PI / 3, aspect = 16 / 9 } = {}) {
  const f = 1 / Math.tan(fov / 2);
  const near = 0.1;
  const far = 1000;
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  // 世界 → 视图：相机在 +z 上朝 -z 看，等价于沿 z 平移 -dist
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -dist, 1];
  return { projection, view, eye: { x: 0, y: 0, z: dist } };
}

const VIEWPORT = { width: 800, height: 450 };

test('矩阵：单位阵相乘不变', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out = new Float64Array(16);
  multiplyMatrix(out, identity, identity);
  assert.deepEqual(Array.from(out), identity);

  const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
  multiplyMatrix(out, identity, translate);
  assert.deepEqual(Array.from(out), translate, '单位阵左乘应等于原矩阵');
});

test('投影：视点在屏幕中心', () => {
  const camera = makeCamera({ dist: 10 });
  const out = new Float64Array(16);
  multiplyMatrix(out, camera.projection, camera.view);
  const point = projectPoint(out, 0, 0, 0, VIEWPORT);
  assert.ok(point.inFrustum, '原点在视锥内');
  assert.ok(Math.abs(point.x - VIEWPORT.width / 2) < 1e-6, `x 应在中心，实际 ${point.x}`);
  assert.ok(Math.abs(point.y - VIEWPORT.height / 2) < 1e-6, `y 应在中心，实际 ${point.y}`);
});

test('投影：世界 +x 在屏幕右侧，世界 +y 在屏幕上方（翻转正确）', () => {
  const camera = makeCamera();
  const out = new Float64Array(16);
  multiplyMatrix(out, camera.projection, camera.view);

  const right = projectPoint(out, 2, 0, 0, VIEWPORT);
  assert.ok(right.x > VIEWPORT.width / 2, '+x 应在右半边');

  const up = projectPoint(out, 0, 2, 0, VIEWPORT);
  // NDC 的 y 向上、屏幕坐标向下，所以世界 +y 的屏幕 y 更小
  assert.ok(up.y < VIEWPORT.height / 2, `+y 应在屏幕上方，实际 ${up.y}`);
});

test('投影：相机背后的点不在视锥内（w<0 不能镜像到屏幕另一侧）', () => {
  const camera = makeCamera({ dist: 10 });
  const out = new Float64Array(16);
  multiplyMatrix(out, camera.projection, camera.view);
  // z = 20 在相机 (z=10) 的背后
  const behind = projectPoint(out, 0, 0, 20, VIEWPORT);
  assert.equal(behind.inFrustum, false);
  assert.equal(behind.x, 0, '背后的点不该给出有效屏幕坐标');
});

test('投影：远处同尺寸物体会更靠中心（透视收敛）', () => {
  const camera = makeCamera();
  const out = new Float64Array(16);
  multiplyMatrix(out, camera.projection, camera.view);
  const near = projectPoint(out, 2, 0, 0, VIEWPORT);
  const far = projectPoint(out, 2, 0, -50, VIEWPORT);
  const nearOffset = Math.abs(near.x - VIEWPORT.width / 2);
  const farOffset = Math.abs(far.x - VIEWPORT.width / 2);
  assert.ok(farOffset < nearOffset, `远处偏移应更小：${farOffset} < ${nearOffset}`);
});

test('射线-AABB：命中、未命中、平行轴', () => {
  const box = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
  // 从 (0,0,5) 朝 -z，走 10 米：盒子在 4 米处
  assert.ok(rayBoxHit(0, 0, 5, 0, 0, -1, box, 10) > 0, '正前方应命中');
  // 同样方向但只走 2 米，够不到
  assert.equal(rayBoxHit(0, 0, 5, 0, 0, -1, box, 2), -1, 'maxT 之外的盒子不算遮挡');
  // 从 (5,0,5) 朝 -z，擦不到
  assert.equal(rayBoxHit(5, 0, 5, 0, 0, -1, box, 10), -1);
  // 平行于 x 轴且 y 在 slab 外
  assert.equal(rayBoxHit(0, 9, 0, 1, 0, 0, box, 10), -1);
  // 起点已在盒内 → tMin = 0
  assert.equal(rayBoxHit(0, 0, 0, 0, 0, -1, box, 10), 0);
});

test('遮挡：被盒子挡住的标签 occluded=true', () => {
  const bridge = new RenderBridge();
  const camera = makeCamera({ dist: 10 });
  bridge.setOccluders([{ minX: -2, minY: -2, minZ: -0.5, maxX: 2, maxY: 2, maxZ: 0.5 }]);
  bridge.addLabel({ id: 'behind', x: 0, y: 0, z: -10 });

  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].occluded, true);
  assert.equal(labels[0].visible, false);
  assert.equal(bridge.stats.occluded, 1);
});

test('遮挡：没有遮挡体时全部可见', () => {
  const bridge = new RenderBridge();
  const camera = makeCamera({ dist: 10 });
  bridge.addLabel({ id: 'a', x: 0, y: 0, z: 0 });
  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels[0].occluded, false);
  assert.equal(labels[0].visible, true);
});

test('遮挡：贴在遮挡体表面上的标签不算被挡（容差）', () => {
  const bridge = new RenderBridge({ occlusionBias: 0.5 });
  const camera = makeCamera({ dist: 10 });
  // 标签在盒子前面 0.2 米处
  bridge.setOccluders([{ minX: -2, minY: -2, minZ: -1, maxX: 2, maxY: 2, maxZ: 0 }]);
  bridge.addLabel({ id: 'surface', x: 0, y: 0, z: 0.2 });
  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels[0].occluded, false, '容差内不该判遮挡');
});

test('去重叠：近的挡住远的，被挡的 visible=false 但仍在结果里', () => {
  const bridge = new RenderBridge({ minSeparation: 44 });
  const camera = makeCamera({ dist: 10 });
  bridge.addLabel({ id: 'near', x: 0, y: 0, z: 0 });
  bridge.addLabel({ id: 'far', x: 0.2, y: 0.1, z: -20 });

  const labels = bridge.update(camera, VIEWPORT);
  const near = labels.find((item) => item.id === 'near');
  const far = labels.find((item) => item.id === 'far');
  assert.equal(near.visible, true);
  assert.equal(far.visible, false, '屏幕位置几乎重合时只留一个');
  assert.equal(labels.length, 2, '被去重叠的标签仍要返回，UI 才能做淡出');
});

test('去重叠：priority 高的优先保留', () => {
  const bridge = new RenderBridge({ minSeparation: 44 });
  const camera = makeCamera({ dist: 10 });
  bridge.addLabel({ id: 'low', x: 0, y: 0, z: 0, priority: 0 });
  bridge.addLabel({ id: 'high', x: 0, y: 0, z: -5, priority: 10 });

  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels.find((item) => item.id === 'high').visible, true);
  assert.equal(labels.find((item) => item.id === 'low').visible, false);
});

test('去重叠：加入顺序不影响结果（确定性）', () => {
  const camera = makeCamera({ dist: 10 });
  const make = (ids) => {
    const bridge = new RenderBridge({ minSeparation: 44 });
    for (const id of ids) bridge.addLabel({ id, x: 0, y: 0, z: id === 'a' ? 0 : -5 });
    return bridge.update(camera, VIEWPORT).map((item) => `${item.id}:${item.visible}`).sort();
  };
  assert.deepEqual(make(['a', 'b']), make(['b', 'a']));
});

test('视锥：maxDistance 之外不显示', () => {
  const bridge = new RenderBridge();
  const camera = makeCamera({ dist: 10 });
  bridge.addLabel({ id: 'far', x: 0, y: 0, z: -80, maxDistance: 50 });
  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels[0].visible, false);
  assert.equal(bridge.stats.culled, 1);
});

test('透视缩放：近大远小，且被钳在 [0.6, 1.4]', () => {
  const bridge = new RenderBridge();
  const camera = makeCamera({ dist: 10 });
  bridge.addLabel({ id: 'near', x: 0, y: 0, z: 5 });
  bridge.addLabel({ id: 'mid', x: 0, y: 3, z: -10 });
  const labels = bridge.update(camera, VIEWPORT);
  const near = labels.find((item) => item.id === 'near');
  const mid = labels.find((item) => item.id === 'mid');
  assert.ok(near.scale >= mid.scale, '近处缩放不小于远处');
  assert.ok(near.scale <= 1.4 && mid.scale >= 0.6);
});

test('容量：maxVisible 之外的标签不显示', () => {
  const bridge = new RenderBridge({ minSeparation: 8, maxVisible: 3 });
  const camera = makeCamera({ dist: 10 });
  for (let i = 0; i < 10; i += 1) {
    bridge.addLabel({ id: `l${i}`, x: -4 + i * 0.9, y: 0, z: 0 });
  }
  const labels = bridge.update(camera, VIEWPORT);
  const visible = labels.filter((item) => item.visible).length;
  assert.ok(visible <= 3, `最多 3 个可见，实际 ${visible}`);
});

test('增删改标签与统计', () => {
  const bridge = new RenderBridge();
  const camera = makeCamera();
  assert.equal(bridge.labelCount, 0);

  bridge.addLabel({ id: 'a', x: 0, y: 0, z: 0 });
  bridge.addLabel({ id: 'a', x: 1, y: 0, z: 0 }); // 同 id 覆盖，不新增
  assert.equal(bridge.labelCount, 1);

  bridge.addLabel({ id: 'b', x: 0, y: 0, z: 0 });
  assert.equal(bridge.labelCount, 2);
  bridge.removeLabel('a');
  assert.equal(bridge.labelCount, 1);
  bridge.clearLabels();
  assert.equal(bridge.labelCount, 0);

  const labels = bridge.update(camera, VIEWPORT);
  assert.equal(labels.length, 0);
  assert.deepEqual(bridge.stats, { total: 0, visible: 0, occluded: 0, culled: 0 });
});
