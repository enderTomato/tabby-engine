/**
 * 探针：单摆与双摆。
 *
 * 验的是两件容易被糊弄过去的事：
 *
 * 1. **单摆有解析解** —— 小角度下数值积分不该偏离解析解。这里并排画两条曲线，
 *    偏了就说明积分器掉了精度。
 * 2. **双摆是混沌的** —— 初始角差 0.001 的两条轨迹会指数发散。
 *    如果它们一直重合，那不是「稳定」，是根本没在按 RK4 积分。
 */

import { DoublePendulum, Pendulum } from '@tabby/physics';
import { addButton, addRow, makeControls, makeOverlay } from './shared.js';
import { batchLine, timeBatch, Timing, type BenchResult, type Probe } from '../types.js';

const TRAIL_MAX = 900;

export function createPendulumProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let single: Pendulum | null = null;
  let twinA: DoublePendulum | null = null;
  let twinB: DoublePendulum | null = null;
  /** 解析解：θ(t) = θ0·cos(√(g/L)·t)（小角度近似）。 */
  let analyticTheta = 0.28;
  let time = 0;
  let paused = false;
  let trailA: number[] = [];
  let trailB: number[] = [];
  /** 双摆末端离悬挂点的最大偏移，用来定坐标缩放。 */
  const stepTiming = new Timing(120);
  let rowAngle: HTMLSpanElement | null = null;
  let rowAnalytic: HTMLSpanElement | null = null;
  let rowDiverge: HTMLSpanElement | null = null;
  let rowStep: HTMLSpanElement | null = null;

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 320) * dpr));
    g2d = canvas.getContext('2d');
  }

  function reset(): void {
    single = new Pendulum({ length: 2.4, gravity: 9.8, damping: 0, angle: 0.28 });
    analyticTheta = 0.28;
    time = 0;
    twinA = new DoublePendulum({ length1: 1.5, length2: 1.5, mass1: 1, mass2: 1, gravity: 9.8, damping: 0, angle1: 1.6, angle2: 2.4 });
    twinB = new DoublePendulum({ length1: 1.5, length2: 1.5, mass1: 1, mass2: 1, gravity: 9.8, damping: 0, angle1: 1.601, angle2: 2.4 });
    trailA = [];
    trailB = [];
  }

  return {
    id: 'pendulum',
    title: '摆动 / 双摆',
    summary: '单摆对得上解析解；双摆 0.001 的初始差异必须指数发散（否则不是 RK4）',
    group: '物理',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      reset();

      const overlay = makeOverlay(context.host, '摆动');
      rowAngle = addRow(overlay, '单摆角（数值）');
      rowAnalytic = addRow(overlay, '单摆角（解析）');
      rowDiverge = addRow(overlay, '双摆末端差');
      rowStep = addRow(overlay, '单步耗时');
      const controls = makeControls(context.host);
      addButton(controls, '重置', () => {
        reset();
        context.log('已重置：单摆回到 0.28 rad，双摆回到 1.6 / 1.601');
      });
      const pauseBtn = addButton(controls, '暂停', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? '继续' : '暂停';
        pauseBtn.classList.toggle('on', paused);
      });
      void pauseBtn;
      context.log('左边是单摆（数值 vs 解析），右边是两个只差 0.001 的双摆');
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
      single = null;
      twinA = null;
      twinB = null;
    },

    tick(_now, dt) {
      if (single === null || twinA === null || twinB === null || canvas === null) return;
      const dtSec = paused ? 0 : Math.min(1 / 30, dt / 1000);
      // 用固定子步积分：dt 抖动会让两条双摆轨迹的差异里混进数值噪声
      const steps = 4;
      const h = dtSec / steps;
      const started = performance.now();
      for (let i = 0; i < steps; i += 1) {
        single.step(h);
        twinA.step(h);
        twinB.step(h);
        // 解析解用同样的时间推进，才能逐点比较
        time += h;
        analyticTheta = 0.28 * Math.cos(Math.sqrt(9.8 / 2.4) * time);
      }
      stepTiming.push(performance.now() - started);

      const tipA = [twinA.tipX, twinA.tipY] as const;
      const tipB = [twinB.tipX, twinB.tipY] as const;
      trailA.push(tipA[0], tipA[1]);
      trailB.push(tipB[0], tipB[1]);
      if (trailA.length > TRAIL_MAX * 2) trailA.splice(0, 2);
      if (trailB.length > TRAIL_MAX * 2) trailB.splice(0, 2);

      const ctx2d = g2d ?? canvas.getContext('2d');
      if (ctx2d === null) return;
      g2d = ctx2d;
      const w = canvas.width;
      const h2 = canvas.height;
      ctx2d.fillStyle = '#06080d';
      ctx2d.fillRect(0, 0, w, h2);

      // ---- 左半：单摆对比
      const leftCx = w * 0.25;
      const pivotY = h2 * 0.18;
      const scale = Math.min(h2 * 0.34, w * 0.16) / 2.6;
      ctx2d.strokeStyle = 'rgba(110,199,255,0.28)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(leftCx, pivotY);
      ctx2d.lineTo(leftCx, pivotY + scale * 3.2);
      ctx2d.stroke();

      const drawArm = (cx: number, angle: number, length: number, color: string, width: number): void => {
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = width;
        ctx2d.beginPath();
        ctx2d.moveTo(cx, pivotY);
        ctx2d.lineTo(cx + Math.sin(angle) * length * scale, pivotY + Math.cos(angle) * length * scale);
        ctx2d.stroke();
      };
      const drawn = readAngle(single);
      // 数值解画粗线，解析解画细线并偏移 1px —— 小角度下两者几乎重合，
      // 不偏移就看不出是「两条线叠在一起」还是「只画了一条」
      drawArm(leftCx, drawn, 2.4, '#6ec7ff', 2.4);
      drawArm(leftCx + 1, analyticTheta, 2.4, '#ffd166', 1.2);

      ctx2d.fillStyle = '#7d8fa3';
      ctx2d.font = `${Math.round(11 * (w / 480))}px ui-monospace, monospace`;
      ctx2d.fillText('单摆：蓝=数值 金=解析', 12, h2 - 14);

      // ---- 右半：双摆轨迹
      const rightCx = w * 0.74;
      const tipScale = Math.min(h2 * 0.3, w * 0.2) / 3.2;
      const drawTrail = (trail: number[], color: string): void => {
        if (trail.length < 4) return;
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        for (let i = 0; i < trail.length; i += 2) {
          const x = rightCx + (trail[i] ?? 0) * tipScale;
          const y = pivotY + (trail[i + 1] ?? 0) * tipScale;
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
      };
      drawTrail(trailA, 'rgba(110,199,255,0.75)');
      drawTrail(trailB, 'rgba(255,123,123,0.75)');

      if (rowAngle !== null) rowAngle.textContent = drawn.toFixed(4);
      if (rowAnalytic !== null) rowAnalytic.textContent = analyticTheta.toFixed(4);
      const dx = tipA[0] - tipB[0];
      const dy = tipA[1] - tipB[1];
      if (rowDiverge !== null) rowDiverge.textContent = Math.hypot(dx, dy).toExponential(2);
      if (rowStep !== null) rowStep.textContent = `${(stepTiming.median * 1000).toFixed(1)}µs`;
    },

    bench(): BenchResult {
      // 一步只有几纳秒到几十纳秒，单次计时必然读到 0 —— 一律批量测
      const single = new Pendulum({ length: 2.4, gravity: 9.8, damping: 0, angle: 0.28 });
      const twin = new DoublePendulum({ length1: 1.5, length2: 1.5, mass1: 1, mass2: 1, gravity: 9.8, damping: 0, angle1: 1.6, angle2: 2.4 });
      const singleStep = timeBatch(() => single.step(1 / 240), 4000);
      const doubleStep = timeBatch(() => twin.step(1 / 240), 4000);
      const ratio = singleStep.perCallUs > 0 ? doubleStep.perCallUs / singleStep.perCallUs : 0;
      return {
        lines: [
          batchLine('单摆一步', singleStep.perCallUs, '4000 步批量均值'),
          batchLine('双摆一步', doubleStep.perCallUs, 'RK4，4 次求导'),
          {
            label: '双摆/单摆',
            value: `${ratio.toFixed(1)}×`,
            hint: ratio > 2 ? 'RK4 四次求导，倍数高才对' : '倍数偏低：双摆可能退化成小角近似',
          },
        ],
      };
    },
  };
}

/** 从 `Pendulum` 读当前角度。字段是公开的，但类型上可能是可选，这里收口。 */
function readAngle(pendulum: Pendulum): number {
  const value = (pendulum as unknown as { angle?: number }).angle;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
