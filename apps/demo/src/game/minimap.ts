/**
 * 小地图 —— 离屏缩略图。
 *
 * ## 为什么是「真·缩略图」而不是直接放大画
 *
 * 一张 12×6 的地图，若每次都按显示尺寸（比如 144×72）重绘 72 个矩形，
 * 一帧要发 72 次 fillRect；而实际上地图只在建造/拆除时变一次。
 *
 * 所以这里维护一张 **12×6 像素**的离屏画布（一块 `ImageData` 就够），
 * 只在脏时重写像素，显示时用 `imageSmoothingEnabled = false` **最近邻放大** 上去。
 * 好处是三重的：
 *
 * 1. 重绘成本与显示尺寸无关（面板放大到 4K 也是 72 次写像素）；
 * 2. 放大后的色块边缘是硬的，像像素地图，比插值糊成一片更清楚；
 * 3. 这块像素缓冲可以直接当**存档预览图**（72 × 4 字节 = 288 字节）。
 *
 * ## 为什么不放进 Vue 的响应式
 *
 * 像素数据进 reactive 会被 Proxy 包一层，每次读都要过 trap。
 * 这里只把「是否脏」暴露成一个布尔给 UI，像素自己留在 typed array 里。
 */

import { CELL_COLOR, Cell, GRID_COLS, GRID_ROWS, TILE_COUNT } from './city';
import { HUB_TILE } from './logistics';

/** 缩略图的显示放大倍数（仅为 CSS 尺寸建议值，实际由目标 canvas 决定）。 */
export const MINIMAP_SCALE = 12;

/** 市政厅格子的颜色：金色，与其它建筑区分。 */
const HUB_COLOR = 0xffd166;
/** 断供建筑的颜色：压暗的红，叠在原本的颜色上。 */
const BLOCKED_TINT = 0x8a1f1f;

function channels(color: number, out: Uint8Array, at: number): void {
  out[at] = (color >> 16) & 0xff;
  out[at + 1] = (color >> 8) & 0xff;
  out[at + 2] = color & 0xff;
  out[at + 3] = 0xff;
}

export class Minimap {
  /** 缩略图像素（RGBA，GRID_COLS × GRID_ROWS）。存档预览直接用它。 */
  readonly pixels: Uint8Array;

  private readonly cells: Int8Array;
  private readonly blocked: Uint8Array;
  private dirty = true;
  private frames = 0;

  constructor(cells: Int8Array) {
    this.cells = cells;
    this.pixels = new Uint8Array(TILE_COUNT * 4);
    this.blocked = new Uint8Array(TILE_COUNT);
    this.invalidate();
  }

  /** 标记需要重绘。建造、拆除、物流状态变化后调用。 */
  invalidate(): void {
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** 累计重绘次数，诊断面板用（数字远小于帧数说明缓存生效）。 */
  get redraws(): number {
    return this.frames;
  }

  /**
   * 标记某地块上的建筑断供。
   *
   * 单独存一层而不是直接改 `cells`：`cells` 是经济层的投影，
   * 往里面写「断供」这种派生状态等于制造第二份真相。
   */
  setBlocked(tile: number, on: boolean): boolean {
    if (tile < 0 || tile >= TILE_COUNT) return false;
    const next = on ? 1 : 0;
    if (this.blocked[tile] === next) return false;
    this.blocked[tile] = next;
    this.dirty = true;
    return true;
  }

  /** 一次性刷新断供图层，返回是否有变化。 */
  setBlockedTiles(tiles: readonly number[]): boolean {
    const next = new Uint8Array(TILE_COUNT);
    for (const tile of tiles) {
      if (tile >= 0 && tile < TILE_COUNT) next[tile] = 1;
    }
    let changed = false;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if (next[tile] !== this.blocked[tile]) {
        this.blocked[tile] = next[tile] as number;
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** 重绘离屏像素。只在脏时真正干活，返回是否重绘了。 */
  render(): boolean {
    if (!this.dirty) return false;
    const bytes = this.pixels;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const kind = this.cells[tile] as number;
      const at = tile * 4;
      if (tile === HUB_TILE) {
        channels(HUB_COLOR, bytes, at);
        continue;
      }
      if (this.blocked[tile] === 1 && kind !== Cell.Empty) {
        channels(BLOCKED_TINT, bytes, at);
        continue;
      }
      channels(CELL_COLOR[kind] ?? 0, bytes, at);
    }
    this.dirty = false;
    this.frames += 1;
    return true;
  }

  /**
   * 把缩略图放大画到目标 canvas 上。
   *
   * 用 `createImageData` + `putImageData` 到临时 canvas 再 `drawImage`：
   * `putImageData` 不能缩放，所以必须先落到一张 1:1 的小 canvas 上。
   * 这张小 canvas 只创建一次并复用（每帧 new 一个 canvas 在安卓上会明显掉帧）。
   */
  blit(target: HTMLCanvasElement): boolean {
    const width = (target.width = GRID_COLS * MINIMAP_SCALE);
    const height = (target.height = GRID_ROWS * MINIMAP_SCALE);
    if (width === 0 || height === 0) return false;

    const ctx = target.getContext('2d');
    if (ctx === null) return false;

    // 即使不脏也要保证首帧有内容
    this.render();

    const source = this.sourceCanvas ?? makeSourceCanvas();
    this.sourceCanvas = source;
    const sctx = source.getContext('2d');
    if (sctx === null) return false;
    const image = sctx.createImageData(GRID_COLS, GRID_ROWS);
    image.data.set(this.pixels);
    sctx.putImageData(image, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, GRID_COLS, GRID_ROWS, 0, 0, width, height);
    return true;
  }

  /** 缩略图的 base64 PNG data URL（存档预览、分享截图用）。 */
  toDataUrl(): string | null {
    if (typeof document === 'undefined') return null;
    this.render();
    const canvas = makeSourceCanvas();
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const image = ctx.createImageData(GRID_COLS, GRID_ROWS);
    image.data.set(this.pixels);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  private sourceCanvas: HTMLCanvasElement | null = null;
}

function makeSourceCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = GRID_COLS;
  canvas.height = GRID_ROWS;
  return canvas;
}
