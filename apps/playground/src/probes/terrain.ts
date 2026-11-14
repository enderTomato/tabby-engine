/**
 * 探针：地形分块与 LOD。
 *
 * 验的是「屏幕误差判据」是不是真的自适应：
 * - 相机拉远，块自动往粗的 LOD 走，三角形数掉下来；
 * - 平地（高差小）在同样的距离上比陡坡用更粗的 LOD；
 * - 拉近又自动变细 —— 不是一张固定分档表。
 *
 * ## 三个参数是配套的，改一个另外两个就得跟着改
 *
 * - **边长必须能被块尺寸整除**：`144 = 16 × 9`。写成 129 会切出 9 块，
 *   而最后一行/列只有 1 格宽（分块是用边缘值补齐的）—— 这些碎片块高差恒为 0，
 *   判据直接把它们判成最粗一级，于是三角形数既不真实也不随距离单调。
 * - **高差区间 90m**：512m 见方的地图上 90m 起伏是丘陵。若按 480m 算（相当于
 *   2:1 的悬崖），每 4m 一格的坡度就足以让任何距离都判不过 3px 误差，
 *   LOD 会永远停在 s1 —— 看起来像没生效。
 * - **误差预算 3px**：2px 太苛刻（4m 网格在 60m 处一格就占 54px），同样会钉死 s1。
 *
 * 用俯视 2D 画块而不是真三角面：这里要验的是**选择结果**，不是光栅化。
 * 画真网格会引入 3D 相机、法线、光照，反而看不清「哪块选了哪级」。
 */

import { HeightField, chunkGrid, selectLodStep } from '@tabby/terrain';
import { addButton, addRow, makeControls, makeOverlay, seededRandom } from './shared.js';
import { batchLine, timeBatch, type BenchResult, type Probe } from '../types.js';

const FIELD_W = 144;
const FIELD_H = 144;
const CELL = 4;
const CHUNK = 16;
/** 高度场的高差区间（米）。见文件头：这个数与 LOD 判据强耦合。 */
const MAX_ELEVATION = 90;

/** 造一张有山有水的高度场：低频正弦 + 一个小山峰 + 一条河谷。 */
function makeField(seed: number): HeightField {
  const rng = seededRandom(seed);
  const data = new Uint16Array(FIELD_W * FIELD_H);
  const peakX = FIELD_W * (0.3 + rng() * 0.4);
  const peakY = FIELD_H * (0.3 + rng() * 0.4);
  for (let row = 0; row < FIELD_H; row += 1) {
    for (let col = 0; col < FIELD_W; col += 1) {
      const base = 0.28 + 0.1 * Math.sin(col * 0.06) * Math.cos(row * 0.075);
      const dx = col - peakX;
      const dy = row - peakY;
      const peak = 0.42 * Math.exp(-(dx * dx + dy * dy) / (2 * 26 * 26));
      const valley = 0.12 * Math.exp(-Math.pow(row - FIELD_H * 0.62, 2) / (2 * 9 * 9));
      const h = Math.max(0, Math.min(1, base + peak - valley + (rng() - 0.5) * 0.01));
      data[row * FIELD_W + col] = Math.round(h * 65535);
    }
  }
  return new HeightField(data, FIELD_W, FIELD_H, CELL, { minElevation: 0, maxElevation: MAX_ELEVATION });
}

export function createTerrainProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let field: HeightField = makeField(11);
  let distance = 260;
  let rowChunks: HTMLSpanElement | null = null;
  let rowTris: HTMLSpanElement | null = null;
  let rowSteps: HTMLSpanElement | null = null;
  let rowSpan: HTMLSpanElement | null = null;

  const grid = chunkGrid(FIELD_W, FIELD_H, CHUNK);
  const options = {
    chunkSize: CHUNK,
    cellSize: CELL,
    maxScreenErrorPx: 3,
    fovY: (48 * Math.PI) / 180,
    viewportHeight: 720,
    maxSteps: 16,
  };

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 320) * dpr));
    g2d = canvas.getContext('2d');
  }

  /** 每个块的高差（用它算屏幕误差，陡的块要更细的 LOD）。 */
  function spanOf(cx: number, cy: number): number {
    let lo = Infinity;
    let hi = -Infinity;
    const c0 = cx * CHUNK;
    const r0 = cy * CHUNK;
    for (let row = r0; row < Math.min(FIELD_H, r0 + CHUNK + 1); row += 1) {
      for (let col = c0; col < Math.min(FIELD_W, c0 + CHUNK + 1); col += 1) {
        const h = field.elevationAt(col, row);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return Number.isFinite(lo) ? hi - lo : 0;
  }

  /**
   * 块到相机的真实距离（米）。
   *
   * ## 为什么不能写成 `俯视半径 × distance × 2`
   *
   * 那样写出来的「距离」在每档相机距离下都按同一个比例缩放，于是 LOD 判据
   * 算出的步长几乎不变 —— 跑分表上看到的三角形数从 6 万到 1200 米只掉 7%，
   * 像是 LOD 没生效。真实相机模型才看得出「远处逐级变粗」：
   * 相机放在 `(0, 60, -d)`，块心用世界坐标，距离取三维欧氏距离。
   */
  function cameraAt(distanceMeters: number): { x: number; y: number; z: number } {
    return { x: 0, y: 60, z: -distanceMeters };
  }

  function blockDistanceOf(cx: number, cy: number, distanceMeters: number): number {
    const centerCol = Math.min(FIELD_W - 1, Math.round((cx + 0.5) * CHUNK));
    const centerRow = Math.min(FIELD_H - 1, Math.round((cy + 0.5) * CHUNK));
    const worldX = (cx + 0.5) * CHUNK * CELL - field.worldWidth / 2;
    const worldZ = (cy + 0.5) * CHUNK * CELL - field.worldHeight / 2;
    const camera = cameraAt(distanceMeters);
    return Math.hypot(worldX - camera.x, field.elevationAt(centerCol, centerRow) - camera.y, worldZ - camera.z);
  }

  /** 给定相机距离，算出全图三角形数与最粗的步长。画面与跑分共用，避免两套口径。 */
  function survey(distanceMeters: number): { triangles: number; chunks: number; maxStep: number } {
    let triangles = 0;
    let maxStep = 1;
    let chunks = 0;
    for (let cy = 0; cy < grid.chunksY; cy += 1) {
      for (let cx = 0; cx < grid.chunksX; cx += 1) {
        const step = selectLodStep(blockDistanceOf(cx, cy, distanceMeters), spanOf(cx, cy), options);
        triangles += Math.pow(CHUNK / step, 2) * 2;
        if (step > maxStep) maxStep = step;
        chunks += 1;
      }
    }
    return { triangles, chunks, maxStep };
  }

  function draw(): void {
    if (canvas === null || g2d === null) return;
    const w = canvas.width;
    const h = canvas.height;
    g2d.fillStyle = '#06080d';
    g2d.fillRect(0, 0, w, h);
    const cellW = w / grid.chunksX;
    const cellH = h / grid.chunksY;
    let triangles = 0;
    const stepCount = new Map<number, number>();
    for (let cy = 0; cy < grid.chunksY; cy += 1) {
      for (let cx = 0; cx < grid.chunksX; cx += 1) {
        const blockDistance = blockDistanceOf(cx, cy, distance);
        const span = spanOf(cx, cy);
        const step = selectLodStep(blockDistance, span, options);
        const quads = Math.pow(CHUNK / step, 2);
        triangles += quads * 2;
        stepCount.set(step, (stepCount.get(step) ?? 0) + 1);

        // LOD 越粗越暗：一眼能看出「远处在变粗」
        const t = Math.min(1, Math.log2(step) / 4);
        const r = Math.round(40 + t * 30);
        const g = Math.round(120 - t * 60);
        const b = Math.round(180 - t * 70);
        g2d.fillStyle = `rgb(${r},${g},${b})`;
        g2d.fillRect(cx * cellW + 1, cy * cellH + 1, cellW - 2, cellH - 2);
        g2d.fillStyle = 'rgba(6,8,13,0.72)';
        const fontSize = Math.max(9, Math.round(cellW * 0.24));
        g2d.font = `${fontSize}px ui-monospace, monospace`;
        g2d.fillText(`s${step}`, cx * cellW + 5, cy * cellH + fontSize + 4);
      }
    }
    if (rowChunks !== null) rowChunks.textContent = `${grid.chunksX}×${grid.chunksY} = ${grid.chunksX * grid.chunksY}`;
    if (rowTris !== null) rowTris.textContent = `${triangles}`;
    if (rowSteps !== null) {
      const parts: string[] = [];
      for (const step of [...stepCount.keys()].sort((a, b) => a - b)) parts.push(`s${step}×${stepCount.get(step)}`);
      rowSteps.textContent = parts.join(' ');
    }
    if (rowSpan !== null) rowSpan.textContent = `${Math.round(field.worldWidth)}m`;
  }

  return {
    id: 'terrain',
    title: '地形分块 / LOD',
    summary: '屏幕误差判据：拉远自动变粗、平地比陡坡更粗；不是固定分档表',
    group: '世界',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      const overlay = makeOverlay(context.host, '地形');
      rowChunks = addRow(overlay, '块数');
      rowTris = addRow(overlay, '三角形');
      rowSteps = addRow(overlay, '步长分布');
      rowSpan = addRow(overlay, '世界跨度');
      const controls = makeControls(context.host);
      addButton(controls, '拉远', () => {
        distance = Math.min(1200, distance * 1.6);
        draw();
      });
      addButton(controls, '拉近', () => {
        distance = Math.max(40, distance / 1.6);
        draw();
      });
      addButton(controls, '换一张图', () => {
        field = makeField(Math.floor(Math.random() * 1e6));
        draw();
        context.log('已重新生成高度场（这是一个唯一用到 Math.random 的地方，只为换图）');
      });
      draw();
      context.log(`${FIELD_W}×${FIELD_H} 格 / 每格 ${CELL}m，每块 ${CHUNK} 格`);
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
    },

    bench(): BenchResult {
      // 单次 LOD 选择只有几十纳秒，必须批量测
      const selection = timeBatch((i) => selectLodStep(40 + (i % 800), (i % 17) * 6, options), 4000);
      const lines = [];
      for (const d of [60, 200, 600, 1200, 2400]) {
        const result = survey(d);
        lines.push({
          label: `相机 ${d}m`,
          value: `${result.triangles} 三角形`,
          hint: `${result.chunks} 块，最粗 s${result.maxStep}`,
        });
      }
      lines.push(batchLine('选一次 LOD', selection.perCallUs, '4000 次批量均值'));
      return { lines };
    },
  };
}
