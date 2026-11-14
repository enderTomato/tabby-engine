/**
 * 探针：风场与烟雾。
 *
 * 验的是：阵风是否真的「一阵一阵」（奇次幂塑形的效果）、噪声是否可复现
 * （同 seed 同坐标同时刻必须给出同一个值 —— 这条破了就没法做回放），
 * 以及烟雾有没有被风拖着走而不是原地膨胀。
 *
 * 用 2D canvas 而不是 3D：风是**矢量场**，俯视切片比斜视角更看得清流向。
 */

import { SmokeSystem, WindField } from '@tabby/physics';
import { addButton, addRow, makeControls, makeOverlay } from './shared.js';
import { batchLine, ms, timeBatch, Timing, type BenchResult, type Probe } from '../types.js';

/** 采样网格的边长（像素）。32 格足够看出涡旋结构。 */
const GRID = 32;

/**
 * 烟雾参数。
 *
 * 与 `PhysicsWorld` 的默认值同源（`world.ts`），但这里要单独给 ——
 * 探针不装整个物理世界，只装烟雾系统，所以得自己把这一组补齐。
 */
const SMOKE_OPTIONS = {
  capacity: 420,
  gravity: -9.8,
  buoyancy: 11,
  drag: 0.8,
  life: 2.6,
  startSize: 0.35,
  endSize: 1.6,
  bounds: { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 9, z: 6 } },
} as const;

export function createWindProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let wind: WindField | null = null;
  let smoke: SmokeSystem | null = null;
  let time = 0;
  let emitTimer = 0;
  let showField = true;
  let paused = false;
  const stepTiming = new Timing(60);
  const sampleScratch = new Float32Array(3);
  let rowGust: HTMLSpanElement | null = null;
  let rowSmoke: HTMLSpanElement | null = null;
  let rowStep: HTMLSpanElement | null = null;
  let rowDeterminism: HTMLSpanElement | null = null;

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 320) * dpr));
    g2d = canvas.getContext('2d');
  }

  return {
    id: 'wind',
    title: '风场 / 烟雾',
    summary: '阵风奇次幂塑形 + 精确哈希噪声；同 seed 同输入必须给出同一个值',
    group: '物理',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      wind = new WindField({ direction: 0.35, speed: 2.4, turbulence: 0.55, gustSpeed: 3.2, gustPeriod: 5.5 });
      smoke = new SmokeSystem(SMOKE_OPTIONS, 7);
      smoke.setWind(wind, 3.2);

      const overlay = makeOverlay(context.host, '风场 / 烟雾');
      rowGust = addRow(overlay, '阵风强度');
      rowSmoke = addRow(overlay, '烟雾粒子');
      rowStep = addRow(overlay, '单步耗时');
      rowDeterminism = addRow(overlay, '噪声自检');
      const controls = makeControls(context.host);
      const fieldBtn = addButton(controls, '隐藏风场', () => {
        showField = !showField;
        fieldBtn.textContent = showField ? '隐藏风场' : '显示风场';
      });
      fieldBtn.classList.add('on');
      addButton(controls, '发一股烟', () => {
        smoke?.emit(0, 0.2, 0, 60, 0.9, 1);
        context.log('在原点放了一股烟');
      });
      const pauseBtn = addButton(controls, '暂停', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? '继续' : '暂停';
        pauseBtn.classList.toggle('on', paused);
      });
      void pauseBtn;

      // 可复现性：同一个 WindField 实例在相同参数下两次采样必须一致
      const a = new Float32Array(3);
      const b = new Float32Array(3);
      wind.sample(1.5, 2.5, 0, 3.25, a);
      wind.sample(1.5, 2.5, 0, 3.25, b);
      const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      const other = new Float32Array(3);
      new WindField({ direction: 0.35, speed: 2.4, turbulence: 0.55, gustSpeed: 3.2, gustPeriod: 5.5 }).sample(
        1.5,
        2.5,
        0,
        3.25,
        other,
      );
      const cross = a[0] === other[0] && a[2] === other[2];
      if (rowDeterminism !== null) {
        rowDeterminism.textContent = same && cross ? '同输入同输出 ✓' : '不一致 ✗';
        rowDeterminism.style.color = same && cross ? 'var(--good)' : 'var(--bad)';
      }
      context.log(`噪声自检：同实例 ${same ? '一致' : '不一致'}，跨实例 ${cross ? '一致' : '不一致'}`);
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
      wind = null;
      smoke = null;
    },

    tick(_now, dt) {
      if (wind === null || smoke === null || canvas === null) return;
      const dtSec = paused ? 0 : dt / 1000;
      time += dtSec;

      const started = performance.now();
      smoke.step(dtSec);
      stepTiming.push(performance.now() - started);

      // 每 0.35 秒从底部随机位置吐一股烟，看起来像被动飘过来的
      emitTimer += dtSec;
      if (emitTimer > 0.35) {
        emitTimer = 0;
        const x = ((Math.sin(time * 0.9) + 1) / 2) * 0.8 - 0.4;
        smoke.emit(x, 0, 0, 9, 0.35, 0.6);
      }

      const ctx2d = g2d ?? canvas.getContext('2d');
      if (ctx2d === null) return;
      g2d = ctx2d;
      const w = canvas.width;
      const h = canvas.height;
      const cell = w / GRID;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = '#06080d';
      ctx2d.fillRect(0, 0, w, h);

      // 风场：颜色表示速度大小，短线段表示方向
      if (showField) {
        for (let gy = 0; gy < GRID; gy += 1) {
          for (let gx = 0; gx < GRID; gx += 1) {
            const wx = (gx / GRID - 0.5) * 8;
            const wz = (gy / GRID - 0.5) * 8;
            wind.sample(wx, 0.5, wz, time, sampleScratch);
            const vx = sampleScratch[0] ?? 0;
            const vz = sampleScratch[2] ?? 0;
            const speed = Math.hypot(vx, vz);
            const intensity = Math.min(1, speed / 6);
            const cx = gx * cell + cell / 2;
            const cy = gy * cell + cell / 2;
            ctx2d.strokeStyle = `rgba(110,199,255,${0.12 + intensity * 0.55})`;
            ctx2d.lineWidth = Math.max(1, cell * 0.09);
            ctx2d.beginPath();
            ctx2d.moveTo(cx, cy);
            ctx2d.lineTo(cx + (vx / (speed || 1)) * cell * 0.42, cy + (vz / (speed || 1)) * cell * 0.42);
            ctx2d.stroke();
          }
        }
      }

      // 烟雾：用 renderData 的 x/z 投影
      const data = smoke.renderData;
      const stride = 6;
      const count = Math.min(smoke.count, Math.floor(data.length / stride));
      for (let i = 0; i < count; i += 1) {
        const base = i * stride;
        const life = data[base + 4] ?? 0;
        const size = data[base + 3] ?? 0.2;
        const px = ((data[base] ?? 0) / 8 + 0.5) * w;
        const py = ((data[base + 2] ?? 0) / 8 + 0.5) * h;
        const radius = Math.max(1.5, size * cell * 1.6);
        ctx2d.beginPath();
        ctx2d.fillStyle = `rgba(220,235,250,${Math.max(0, 0.42 * (1 - life))})`;
        ctx2d.arc(px, py, radius, 0, Math.PI * 2);
        ctx2d.fill();
      }

      if (rowGust !== null) rowGust.textContent = `${wind.gust(time).toFixed(2)}`;
      if (rowSmoke !== null) rowSmoke.textContent = `${count}`;
      if (rowStep !== null) rowStep.textContent = ms(stepTiming.median);
    },

    bench(): BenchResult {
      const field = new WindField({ direction: 0.35, speed: 2.4, turbulence: 0.55 });
      const out = new Float32Array(3);
      // 单次采样只有几十纳秒，低于时钟分辨率 —— 必须批量测
      const sampling = timeBatch((i) => field.sample((i % 40) * 0.37, 0.5, (i % 31) * 0.21, i * 0.016, out), 4000);

      const system = new SmokeSystem(SMOKE_OPTIONS, 7);
      system.setWind(field, 3.2);
      system.emit(0, 0, 0, 400, 1, 1);
      const stepTiming2 = new Timing(60);
      for (let i = 0; i < 60; i += 1) {
        const started = performance.now();
        system.step(1 / 60);
        stepTiming2.push(performance.now() - started);
      }
      return {
        lines: [
          batchLine('单次采样', sampling.perCallUs, '4000 次批量均值，已扣空循环'),
          { label: '420 粒子单步', value: ms(stepTiming2.median), hint: `p95 ${ms(stepTiming2.p95)}` },
        ],
      };
    },
  };
}
