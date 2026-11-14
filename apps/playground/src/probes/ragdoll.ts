/**
 * 探针：布娃娃。
 *
 * 验的是：关节约束会不会散架、休眠后能不能被唤醒、以及**点数涨了之后
 * 宽相位还撑不撑得住**（这是物理包里最容易被「只在 demo 里跑 2 个」掩盖的问题）。
 *
 * 人形骨架的连线拓扑不是公开契约（`positions` 只承诺「每 3 个 float 一个关节」），
 * 所以这里不去猜哪两根骨头相连，而是用**关节点 + 质心轨迹**呈现运动。
 * 猜拓扑写死连线，一旦骨骼定义顺序变了就会画出交叉的鬼线。
 */

import { PointsLayer } from '@tabby/render3d';
import { PhysicsWorld } from '@tabby/physics';
import * as THREE from 'three';
import { addButton, addRow, attachOrbit, createThreeStage, makeControls, makeOverlay, type ThreeStage } from './shared.js';
import { ms, Timing, type BenchResult, type Probe } from '../types.js';

const MAX_RAGDOLLS = 12;

export function createRagdollProbe(): Probe {
  let stage: ThreeStage | null = null;
  let detachOrbit: (() => void) | null = null;
  let world: PhysicsWorld | null = null;
  let joints: PointsLayer | null = null;
  let trail: THREE.Line | null = null;
  let trailPositions: Float32Array | null = null;
  let trailCount = 0;
  let spawnSeq = 0;
  const ids: string[] = [];
  const stepTiming = new Timing(90);
  let rowCount: HTMLSpanElement | null = null;
  let rowSleep: HTMLSpanElement | null = null;
  let rowStep: HTMLSpanElement | null = null;
  let rowCom: HTMLSpanElement | null = null;

  function drop(offsetX = 0, offsetZ = 0): void {
    if (world === null) return;
    spawnSeq += 1;
    const id = `rag-${spawnSeq}`;
    if (ids.length >= MAX_RAGDOLLS) {
      const oldest = ids.shift();
      if (oldest !== undefined) world.removeRagdoll(oldest);
    }
    const ragdoll = world.spawnHumanoid(id, offsetX, 9 + (spawnSeq % 3) * 0.6, offsetZ, 1);
    ragdoll.addRadialImpulse(offsetX, 9, offsetZ, 1.8, 4);
    ids.push(id);
  }

  function pushTrail(x: number, y: number, z: number): void {
    if (trailPositions === null || trail === null) return;
    const capacity = trailPositions.length / 3;
    if (trailCount >= capacity) {
      // 循环覆盖：把后面的点整体前移一格，比 shift 数组省
      trailPositions.copyWithin(0, 3);
      trailCount = capacity - 1;
    }
    const at = trailCount * 3;
    trailPositions[at] = x;
    trailPositions[at + 1] = y;
    trailPositions[at + 2] = z;
    trailCount += 1;
    const attribute = trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    trail.geometry.setDrawRange(0, Math.max(2, trailCount - 1));
  }

  return {
    id: 'ragdoll',
    title: '布娃娃',
    summary: '关节约束 + 休眠唤醒；关节成倍增加时宽相位单步耗时是否仍近线性',
    group: '物理',

    mount(context) {
      stage = createThreeStage(context.host);
      detachOrbit = attachOrbit(stage.canvas, stage.camera);
      world = new PhysicsWorld({ fluid: null, liquid: null, smoke: null, seed: 0x5eed });

      joints = new PointsLayer({ capacity: 320, color: 0xffd166, sizeScale: 190, opacity: 0.95 });
      stage.scene.add(joints.object);

      trailPositions = new Float32Array(240 * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
      geometry.setDrawRange(0, 0);
      trail = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x6ec7ff, transparent: true, opacity: 0.7 }));
      stage.scene.add(trail);

      for (const [x, z] of [
        [-2.6, 0],
        [2.6, 0],
        [0, -2.6],
      ] as const) {
        drop(x, z);
      }

      const overlay = makeOverlay(context.host, '布娃娃');
      rowCount = addRow(overlay, '关节 / 个体');
      rowSleep = addRow(overlay, '休眠中');
      rowStep = addRow(overlay, '单步耗时');
      rowCom = addRow(overlay, '质心高度');
      const controls = makeControls(context.host);
      addButton(controls, '丢一个', () => drop((spawnSeq % 5) - 2, ((spawnSeq * 3) % 5) - 2));
      addButton(controls, '全部唤醒', () => {
        world?.wakeAllRagdolls();
        context.log('已唤醒全部布娃娃');
      });
      addButton(controls, '清空', () => {
        for (const id of ids) world?.removeRagdoll(id);
        ids.length = 0;
        trailCount = 0;
        trail?.geometry.setDrawRange(0, 0);
      });
      context.log('拖动可转视角；「全部唤醒」用来验证休眠后能被外部唤醒');
    },

    unmount() {
      joints?.dispose();
      joints = null;
      trail?.geometry.dispose();
      (trail?.material as THREE.Material | undefined)?.dispose();
      trail = null;
      trailPositions = null;
      detachOrbit?.();
      detachOrbit = null;
      stage?.dispose();
      stage = null;
      world = null;
    },

    tick(_now, dt) {
      if (world === null || stage === null || joints === null) return;
      const started = performance.now();
      world.step(dt / 1000);
      stepTiming.push(performance.now() - started);

      const order = world.getRagdollOrder();
      const total = order.length;
      let sleeping = 0;
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let samples = 0;
      // 所有布娃娃的关节拼进同一块缓冲：一次 update、一个 DrawCall
      const packed = new Float32Array(order.length * 4 * 3);
      let at = 0;
      for (const ragdoll of order) {
        if (ragdoll.isAsleep) sleeping += 1;
        const positions = ragdoll.positions;
        for (let b = 0; b < ragdoll.boneCount; b += 1) {
          const bx = positions[b * 3] ?? 0;
          const by = positions[b * 3 + 1] ?? 0;
          const bz = positions[b * 3 + 2] ?? 0;
          sumX += bx;
          sumY += by;
          sumZ += bz;
          samples += 1;
          if (at + 2 < packed.length) {
            packed[at] = bx;
            packed[at + 1] = by;
            packed[at + 2] = bz;
            at += 3;
          }
        }
      }
      joints.update(packed, at / 3, 3);
      if (samples > 0) pushTrail(sumX / samples, sumY / samples, sumZ / samples);

      if (rowCount !== null) rowCount.textContent = `${at / 3} / ${total}`;
      if (rowSleep !== null) rowSleep.textContent = `${sleeping}`;
      if (rowStep !== null) rowStep.textContent = ms(stepTiming.median);
      if (rowCom !== null) rowCom.textContent = samples > 0 ? (sumY / samples).toFixed(2) : '—';
      stage.renderer.render(stage.scene, stage.camera);
    },

    async bench(): Promise<BenchResult> {
      if (world === null) return { lines: [{ label: '状态', value: '未挂载' }] };
      const lines = [];
      for (const count of [1, 4, 12]) {
        const local = new PhysicsWorld({ fluid: null, liquid: null, smoke: null, seed: 7 });
        const localIds: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const id = `b${i}`;
          local.spawnHumanoid(id, (i % 4) * 1.2 - 2, 8, Math.floor(i / 4) * 1.2 - 1.5, 1);
          localIds.push(id);
        }
        const timing = new Timing(60);
        for (let i = 0; i < 60; i += 1) {
          const started = performance.now();
          local.step(1 / 60);
          timing.push(performance.now() - started);
        }
        let joints = 0;
        for (const id of localIds) joints += local.getRagdoll(id)?.boneCount ?? 0;
        lines.push({ label: `${count} 个人形`, value: ms(timing.median), hint: `${joints} 关节，p95 ${ms(timing.p95)}` });
      }
      return { lines };
    },
  };
}
