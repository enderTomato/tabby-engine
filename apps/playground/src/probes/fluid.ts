/**
 * 探针：液体（粒子流体）。
 *
 * 验的是三件事：
 * 1. 水真的会流 —— 从水塔落下、撞到挡板后横向铺开，而不是垂直穿过去；
 * 2. 宽相位没退化 —— 粒子数涨 4 倍，单步耗时不该涨 16 倍；
 * 3. 容量满了不崩 —— `spawn` 返回实际生成数，溢出的被安静丢掉。
 */

import { PointsLayer } from '@tabby/render3d';
import { PhysicsWorld } from '@tabby/physics';
import * as THREE from 'three';
import { addButton, addRow, attachOrbit, createThreeStage, makeControls, makeOverlay, type ThreeStage } from './shared.js';
import { ms, Timing, type BenchResult, type Probe } from '../types.js';

const CAPACITY = 1200;

export function createFluidProbe(): Probe {
  let stage: ThreeStage | null = null;
  let detachOrbit: (() => void) | null = null;
  let world: PhysicsWorld | null = null;
  let layer: PointsLayer | null = null;
  let emitTimer = 0;
  let emitting = true;
  let frames = 0;
  const stepTiming = new Timing(90);
  let rowParticles: HTMLSpanElement | null = null;
  let rowStep: HTMLSpanElement | null = null;
  let rowFps: HTMLSpanElement | null = null;

  function reset(): void {
    if (world === null) return;
    world.fluid?.reset();
    emitTimer = 0;
  }

  return {
    id: 'fluid',
    title: '液体（粒子流体）',
    summary: '水塔落水撞挡板横向铺开；宽相位让单步耗时随粒子数近似线性',
    group: '物理',

    mount(context) {
      stage = createThreeStage(context.host);
      detachOrbit = attachOrbit(stage.canvas, stage.camera);
      world = new PhysicsWorld({
        fluid: { capacity: CAPACITY },
        liquid: null,
        // 探针只要验液体，把另外两套解法关掉，免得混淆耗时来源
        smoke: null,
        seed: 20240501,
      });
      // 挡板：水必须撞到它才会横向铺开，否则只是一根垂直下落的水柱
      world.addObstacle({ id: 'ramp', kind: 'solid', min: { x: -1.6, y: 0, z: -1.6 }, max: { x: 1.6, y: 1.2, z: 1.6 } });
      const ramp = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 1.2, 3.2),
        new THREE.MeshStandardMaterial({ color: 0x2a3f52, roughness: 0.8 }),
      );
      ramp.position.set(0, 0.6, 0);
      stage.scene.add(ramp);

      layer = new PointsLayer({
        capacity: CAPACITY,
        color: 0x59b6ff,
        sizeScale: 220,
        opacity: 0.86,
        dynamicSize: false,
      });
      stage.scene.add(layer.object);

      const overlay = makeOverlay(context.host, '液体');
      rowParticles = addRow(overlay, '粒子数');
      rowStep = addRow(overlay, '单步耗时');
      rowFps = addRow(overlay, '累计帧');
      const controls = makeControls(context.host);
      const toggle = addButton(controls, '暂停出水', () => {
        emitting = !emitting;
        toggle.classList.toggle('on', !emitting);
        toggle.textContent = emitting ? '暂停出水' : '恢复出水';
      });
      addButton(controls, '清空', () => reset());
      context.log(`流体容量 ${CAPACITY}，撞到挡板后会横向铺开`);
    },

    unmount() {
      layer?.dispose();
      layer = null;
      detachOrbit?.();
      detachOrbit = null;
      stage?.dispose();
      stage = null;
      world = null;
    },

    tick(_now, dt) {
      if (world === null || stage === null || layer === null) return;
      const dtSec = dt / 1000;
      if (emitting) {
        emitTimer += dtSec;
        // 60Hz 出水：一次撒太多会让粒子在出口处炸开
        while (emitTimer >= 1 / 60) {
          emitTimer -= 1 / 60;
          world.fluid?.spawn(7, 0, 11.5, 0, 0.06, 0.05, 0.06);
        }
      }
      const started = performance.now();
      world.step(dtSec);
      stepTiming.push(performance.now() - started);

      const fluid = world.fluid;
      if (fluid !== null) {
        layer.update(fluid.positions, fluid.count, 3);
        if (rowParticles !== null) rowParticles.textContent = `${fluid.count} / ${CAPACITY}`;
      }
      if (rowStep !== null) rowStep.textContent = ms(stepTiming.median);
      if (rowFps !== null) rowFps.textContent = `${(frames += 1)}`;
      stage.renderer.render(stage.scene, stage.camera);
    },

    async bench(): Promise<BenchResult> {
      if (world === null) {
        return { lines: [{ label: '状态', value: '未挂载' }] };
      }
      // 三档粒子数各跑 60 步：看单步耗时是不是近似线性
      const lines = [];
      for (const count of [200, 600, 1200]) {
        world.fluid?.reset();
        const fluid = world.fluid;
        if (fluid !== null) fluid.spawn(count, 0, 12, 0, 0.4, 0.4, 0.4);
        const timing = new Timing(60);
        for (let i = 0; i < 60; i += 1) {
          const started = performance.now();
          world.step(1 / 60);
          timing.push(performance.now() - started);
        }
        lines.push({ label: `${count} 粒子单步`, value: ms(timing.median), hint: `p95 ${ms(timing.p95)}` });
      }
      return { lines };
    },
  };
}
