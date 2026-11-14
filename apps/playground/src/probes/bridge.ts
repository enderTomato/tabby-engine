/**
 * 探针：3D → DOM 渲染桥。
 *
 * 血条、建筑名、伤害数字这些东西必须跟着 3D 物体走，但**不能**用 CSS3DRenderer
 * （每个标签一个 DOM 层，几十个就把合成器压垮）。正解是自己算投影，然后写
 * `transform: translate3d()` —— 不进布局、不进 Vue 响应式。
 *
 * 这个探针把桥的三条判定分别暴露出来，颜色区分：
 *
 * - **青**：可见（在视锥内、没被挡、通过去重叠）
 * - **灰**：被遮挡（射线打到了前面的 AABB）
 * - **暗红**：在视锥外（`w < 0`，即相机背后 —— 这条最容易被写错，
 *   不判 `w` 的话相机背后的标签会翻转着出现在屏幕上）
 * - **橙**：被去重叠挤掉了（两个标签靠太近，只留优先级高的）
 *
 * 转动相机就能看到这四种状态互相切换；挡板可以开关，用来验证遮挡。
 */

import * as THREE from 'three';
import { RenderBridge, type BridgeLabel, type OccluderBox } from '@tabby/render3d';
import { addButton, addRow, attachOrbit, createThreeStage, makeControls, makeOverlay, type ThreeStage } from './shared.js';
import { ms, Timing, type BenchResult, type Probe } from '../types.js';

const COLS = 5;
const ROWS = 4;
const SPACING = 3.4;

interface Building {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly mesh: THREE.Mesh;
}

export function createBridgeProbe(): Probe {
  let stage: ThreeStage | null = null;
  let overlayCanvas: HTMLCanvasElement | null = null;
  let o2d: CanvasRenderingContext2D | null = null;
  let bridge: RenderBridge | null = null;
  let buildings: Building[] = [];
  let wall: THREE.Mesh | null = null;
  let wallEnabled = true;
  let showHidden = true;
  let detachOrbit: (() => void) | null = null;
  let rowVisible: HTMLSpanElement | null = null;
  let rowOccluded: HTMLSpanElement | null = null;
  let rowCulled: HTMLSpanElement | null = null;
  let rowOverlap: HTMLSpanElement | null = null;
  let rowUpdate: HTMLSpanElement | null = null;
  const updateTiming = new Timing(120);

  return {
    id: 'bridge',
    title: '渲染桥（3D → DOM）',
    summary: '自己算投影不 import three；w<0 必须判出视锥、射线-AABB 判遮挡、44px 去重叠',
    group: '渲染',

    mount(context) {
      stage = createThreeStage(context.host);
      detachOrbit = attachOrbit(stage.canvas, stage.camera, new THREE.Vector3(0, 2.5, 0));

      // 叠一层 2D canvas：不是引擎实现，只是把桥的输出画出来给人看
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.style.position = 'absolute';
      overlayCanvas.style.inset = '0';
      overlayCanvas.style.pointerEvents = 'none';
      context.host.appendChild(overlayCanvas);
      o2d = overlayCanvas.getContext('2d');

      bridge = new RenderBridge({ minSeparation: 44, occlusionBias: 0.35, maxVisible: 64 });
      buildings = [];
      wallEnabled = true;

      const material = new THREE.MeshStandardMaterial({ color: 0x2a4a66, roughness: 0.6, metalness: 0.15 });
      const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x552233, roughness: 0.9, metalness: 0 });

      for (let row = 0; row < ROWS; row += 1) {
        for (let col = 0; col < COLS; col += 1) {
          const x = (col - (COLS - 1) / 2) * SPACING;
          const z = (row - (ROWS - 1) / 2) * SPACING;
          const height = 1.2 + ((col * 7 + row * 13) % 5) * 0.45;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, height, 1.5), material);
          mesh.position.set(x, height / 2, z);
          stage.scene.add(mesh);
          const id = `b-${col}-${row}`;
          buildings.push({ id, x, z, height, mesh });
          bridge.addLabel({ id, x, y: height + 0.6, z, priority: col + row, kind: 'building' } satisfies BridgeLabel);
        }
      }

      // 挡板：一个又高又宽的盒子，专门用来挡住后排建筑
      wall = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 0.6), wallMaterial);
      wall.position.set(0, 2.5, 1.2);
      stage.scene.add(wall);

      const overlay = makeOverlay(context.host, '渲染桥');
      rowVisible = addRow(overlay, '可见标签');
      rowOccluded = addRow(overlay, '被遮挡');
      rowCulled = addRow(overlay, '视锥外');
      rowOverlap = addRow(overlay, '去重叠挤掉');
      rowUpdate = addRow(overlay, '单次 update');

      const controls = makeControls(context.host);
      const wallBtn = addButton(controls, '隐藏挡板', () => {
        wallEnabled = !wallEnabled;
        if (wall !== null) wall.visible = wallEnabled;
        wallBtn.textContent = wallEnabled ? '隐藏挡板' : '显示挡板';
        wallBtn.classList.toggle('on', !wallEnabled);
        context.log(wallEnabled ? '挡板已放回' : '挡板已移除 —— 后排标签应该重新出现');
      });
      wallBtn.classList.add('on');
      const hiddenBtn = addButton(controls, '只画可见', () => {
        showHidden = !showHidden;
        hiddenBtn.textContent = showHidden ? '只画可见' : '画出全部';
        hiddenBtn.classList.toggle('on', !showHidden);
      });
      void hiddenBtn;
      context.log(`已放置 ${buildings.length} 栋建筑，拖拽转相机看四种状态切换`);
    },

    unmount() {
      detachOrbit?.();
      detachOrbit = null;
      o2d = null;
      overlayCanvas?.remove();
      overlayCanvas = null;
      stage?.dispose();
      stage = null;
      bridge = null;
      buildings = [];
      wall = null;
    },

    tick() {
      if (stage === null || o2d === null || overlayCanvas === null || bridge === null) return;

      stage.camera.updateMatrixWorld();
      const width = overlayCanvas.clientWidth || 1;
      const height = overlayCanvas.clientHeight || 1;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      if (overlayCanvas.width !== Math.round(width * dpr) || overlayCanvas.height !== Math.round(height * dpr)) {
        overlayCanvas.width = Math.max(1, Math.round(width * dpr));
        overlayCanvas.height = Math.max(1, Math.round(height * dpr));
      }

      // 遮挡体：只有可见的挡板才算遮挡，否则「隐藏了还在挡」会让人怀疑桥坏了
      const occluders: OccluderBox[] = [];
      if (wall !== null && wallEnabled) {
        occluders.push({ minX: -7, minY: 0, maxX: 7, maxY: 5, minZ: 0.9, maxZ: 1.5 });
      }
      bridge.setOccluders(occluders);

      const started = performance.now();
      const labels = bridge.update(
        {
          projection: stage.camera.projectionMatrix.elements,
          // 注意是 matrixWorldInverse（世界→视图）。传 matrixWorld 不会报错，
          // 但标签会以相机为圆心里外翻转 —— 典型的「不炸但全错」。
          view: stage.camera.matrixWorldInverse.elements,
          eye: { x: stage.camera.position.x, y: stage.camera.position.y, z: stage.camera.position.z },
        },
        { width, height },
      );
      updateTiming.push(performance.now() - started);

      stage.renderer.render(stage.scene, stage.camera);

      const ctx2d = o2d;
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      ctx2d.scale(dpr, dpr);

      let visible = 0;
      let occluded = 0;
      let culled = 0;
      for (const label of labels) {
        if (label.visible) visible += 1;
        else if (label.occluded) occluded += 1;
        else culled += 1;
        if (!label.visible && !showHidden) continue;

        const color = label.visible
          ? 'rgba(110,199,255,0.95)'
          : label.occluded
            ? 'rgba(150,160,175,0.45)'
            : 'rgba(255,107,107,0.45)';
        const scale = label.visible ? Math.max(0.55, Math.min(1.4, label.scale)) : 0.55;
        const radius = 10 * scale;

        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1.4;
        ctx2d.beginPath();
        ctx2d.moveTo(label.x, label.y - radius * 0.4);
        ctx2d.lineTo(label.x, label.y + radius * 0.4);
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.moveTo(label.x - radius * 0.4, label.y);
        ctx2d.lineTo(label.x + radius * 0.4, label.y);
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.strokeRect(label.x - radius, label.y - radius * 0.7, radius * 2, radius * 1.4);

        ctx2d.fillStyle = color;
        ctx2d.font = `${Math.round(10 * scale)}px ui-monospace, monospace`;
        ctx2d.fillText(label.visible ? label.id : label.occluded ? '遮挡' : '视锥外', label.x + radius + 3, label.y + 3);
      }

      const stats = bridge.stats;
      const overlap = Math.max(0, labels.length - stats.visible - stats.occluded - stats.culled);
      if (rowVisible !== null) rowVisible.textContent = `${visible} / ${labels.length}`;
      if (rowOccluded !== null) rowOccluded.textContent = `${occluded}`;
      if (rowCulled !== null) rowCulled.textContent = `${culled}`;
      if (rowOverlap !== null) rowOverlap.textContent = `${overlap}`;
      if (rowUpdate !== null) rowUpdate.textContent = `${(updateTiming.median * 1000).toFixed(1)}µs`;
    },

    bench(): BenchResult {
      const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
      camera.position.set(9, 7, 13);
      camera.lookAt(0, 2, 0);
      camera.updateMatrixWorld(true);

      const matrices = {
        projection: camera.projectionMatrix.elements,
        view: camera.matrixWorldInverse.elements,
        eye: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      };
      const viewport = { width: 1440, height: 810 };

      const rows: string[] = [];
      for (const count of [64, 256, 1024]) {
        const probe = new RenderBridge({ minSeparation: 44, occlusionBias: 0.35, maxVisible: 64 });
        for (let i = 0; i < count; i += 1) {
          probe.addLabel({
            id: `l-${String(i).padStart(4, '0')}`,
            x: ((i % 32) - 16) * 1.6,
            y: 1.5 + (i % 5),
            z: (Math.floor(i / 32) - 8) * 1.6,
            priority: i % 7,
          });
        }
        probe.setOccluders([{ minX: -30, minY: 0, maxX: 30, maxY: 4, minZ: -2, maxZ: -1 }]);
        // 预热一次：JIT 与数组扩容都算在第一次调用里，不该计入中位数
        probe.update(matrices, viewport);
        const timing = new Timing(120);
        for (let i = 0; i < 120; i += 1) {
          const started = performance.now();
          const out = probe.update(matrices, viewport);
          timing.push(performance.now() - started);
          if (out.length === 0) break;
        }
        rows.push(`${count} 标签 ${(timing.median * 1000).toFixed(0)}µs`);
      }

      const single = new RenderBridge({ minSeparation: 44 });
      for (let i = 0; i < 256; i += 1) {
        single.addLabel({ id: `p-${i}`, x: (i % 16) * 1.2, y: 2, z: Math.floor(i / 16) * 1.2 });
      }
      single.update(matrices, viewport);
      const withOccl = new Timing(60);
      const withoutOccl = new Timing(60);
      for (let i = 0; i < 60; i += 1) {
        const t0 = performance.now();
        single.setOccluders([{ minX: -20, minY: 0, maxX: 20, maxY: 4, minZ: -1, maxZ: 0 }]);
        single.update(matrices, viewport);
        withOccl.push(performance.now() - t0);

        const t1 = performance.now();
        single.setOccluders([]);
        single.update(matrices, viewport);
        withoutOccl.push(performance.now() - t1);
      }

      return {
        lines: [
          { label: '规模扫描', value: rows.join(' / '), hint: '1440×810 视口，120 次中位数' },
          {
            label: '遮挡开销',
            value: `+${ms(Math.max(0, withOccl.median - withoutOccl.median))}`,
            hint: `1 个 AABB：${ms(withOccl.median)} vs 无遮挡 ${ms(withoutOccl.median)}`,
          },
          { label: '当前 update', value: `${(updateTiming.median * 1000).toFixed(1)}µs`, hint: `p95 ${(updateTiming.p95 * 1000).toFixed(0)}µs` },
        ],
      };
    },
  };
}
