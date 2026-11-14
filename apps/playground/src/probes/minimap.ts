/**
 * 探针：小地图（`@tabby/ui` 的 `Minimap`）。
 *
 * 验的是「真缩略图」这个说法：像素缓冲只有 `cols × rows`，重绘次数应当
 * 与帧数完全脱钩 —— 稳态下 `redraws` 停住不动，而画面还在每帧放大重绘。
 * 这个数字如果跟着帧数涨，说明缓存没起作用，那样在手机上会一直烧胶水。
 */

import { Minimap, type MinimapSpec } from '@tabby/ui';
import { addButton, addRow, makeControls, makeOverlay, seededRandom } from './shared.js';
import { batchLine, timeBatch, Timing, type BenchResult, type Probe } from '../types.js';

const COLS = 16;
const ROWS = 10;

const SPEC: MinimapSpec = {
  cols: COLS,
  rows: ROWS,
  palette: [0x0a1018, 0xc9714a, 0x54b25a, 0x6d7f95, 0x3c6f9e],
  pins: [
    { tile: 0, color: 0xffd166 },
    { tile: COLS * ROWS - 1, color: 0xff7b7b },
  ],
  blockedTint: 0x8a1f1f,
  emptyValue: 0,
  scale: 11,
};

export function createMinimapProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let cells = new Int8Array(COLS * ROWS);
  let map: Minimap | null = null;
  let frames = 0;
  let blits = 0;
  let dirtyTouches = 0;
  let rowPixels: HTMLSpanElement | null = null;
  let rowRedraws: HTMLSpanElement | null = null;
  let rowBlits: HTMLSpanElement | null = null;
  let rowFrames: HTMLSpanElement | null = null;
  const blitTiming = new Timing(120);

  function paint(seed: number): void {
    const rng = seededRandom(seed);
    const next = new Int8Array(COLS * ROWS);
    for (let i = 0; i < next.length; i += 1) {
      const roll = rng();
      next[i] = roll < 0.5 ? 0 : roll < 0.66 ? 1 : roll < 0.82 ? 2 : roll < 0.92 ? 3 : 4;
    }
    cells = next;
    // 换了 cells 数组就必须重建：Minimap 构造时拿的是引用，不会跟着换
    map = new Minimap(SPEC, cells);
    dirtyTouches += 1;
  }

  return {
    id: 'minimap',
    title: '小地图',
    summary: '真缩略图：像素缓冲只有 16×10，重绘次数与帧数脱钩；放大用最近邻',
    group: '经营',

    mount(context) {
      canvas = document.createElement('canvas');
      // 给一个固定 CSS 尺寸：小地图是「放大的小画布」，不该跟着窗口无限拉伸
      canvas.style.width = '352px';
      canvas.style.height = '220px';
      canvas.style.left = '50%';
      canvas.style.top = '50%';
      canvas.style.transform = 'translate(-50%, -50%)';
      canvas.style.imageRendering = 'pixelated';
      context.host.appendChild(canvas);

      paint(101);
      const overlay = makeOverlay(context.host, '小地图');
      rowPixels = addRow(overlay, '像素缓冲');
      rowRedraws = addRow(overlay, '累计重绘');
      rowBlits = addRow(overlay, '累计放大');
      rowFrames = addRow(overlay, '累计帧');
      const controls = makeControls(context.host);
      addButton(controls, '随机构图', () => {
        paint(Math.floor(Math.random() * 1e6));
        context.log('换了构图：重绘次数应该只 +1');
      });
      addButton(controls, '标脏（不换图）', () => {
        map?.invalidate();
        dirtyTouches += 1;
        context.log('只标脏，像素内容没变 —— 重绘次数仍会 +1（脏就是脏）');
      });
      addButton(controls, '导出 PNG', () => {
        const url = map?.toDataUrl() ?? null;
        context.log(url === null ? '导出失败（无 document？）' : `dataURL 长度 ${url.length} 字节`);
      });
      context.log('像素缓冲 16×10×4 = 640 字节；显示尺寸 352×220 是最近邻放大');
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      map = null;
    },

    tick() {
      if (canvas === null) return;
      frames += 1;
      const mini = map;
      if (mini === null) return;
      if (mini.isDirty) {
        const started = performance.now();
        mini.blit(canvas);
        blitTiming.push(performance.now() - started);
        blits += 1;
      } else {
        // 不脏也要保证首帧有内容：blit 内部会判脏，所以这里只在首帧强制一次
        if (blits === 0) {
          mini.blit(canvas);
          blits += 1;
        }
      }
      if (rowPixels !== null) rowPixels.textContent = `${COLS}×${ROWS} = ${COLS * ROWS * 4} 字节`;
      if (rowRedraws !== null) rowRedraws.textContent = `${mini.redraws}`;
      if (rowBlits !== null) rowBlits.textContent = `${blits}`;
      if (rowFrames !== null) rowFrames.textContent = `${frames}`;
    },

    bench(): BenchResult {
      const local = new Minimap(SPEC, cells);
      // 整图重绘是微秒级，单次计时会读到 0/5µs 两档（时钟分辨率），所以批量测
      const redraw = timeBatch(() => {
        local.invalidate();
        local.render();
      }, 500);
      return {
        lines: [
          { label: '像素缓冲', value: `${COLS * ROWS * 4} 字节`, hint: `对应 ${COLS}×${ROWS} 格` },
          batchLine('整图重绘', redraw.perCallUs, `${COLS * ROWS} 格逐格写，500 次批量`),
          { label: '当前重绘/帧', value: `${map?.redraws ?? 0} / ${frames}`, hint: '稳态下重绘数应远小于帧数' },
          { label: '标脏次数', value: `${dirtyTouches}` },
        ],
      };
    },
  };
}
