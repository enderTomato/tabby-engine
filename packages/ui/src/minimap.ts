/**
 * 小地图 —— 参数化的离屏缩略图。
 *
 * ## 为什么是「真·缩略图」而不是直接放大画
 *
 * 一张 12×6 的地图，若每次都按显示尺寸（比如 144×72）重绘 72 个矩形，
 * 一帧要发 72 次 fillRect；而实际上地图只在建造/拆除时变一次。
 *
 * 所以这里维护一张 **cols × rows 像素**的离屏画布（一块 `ImageData` 就够），
 * 只在脏时重写像素，显示时用 `imageSmoothingEnabled = false` **最近邻放大** 上去。
 * 好处是三重的：
 *
 * 1. 重绘成本与显示尺寸无关（面板放大到 4K 也是每格一次写像素）；
 * 2. 放大后的色块边缘是硬的，像像素地图，比插值糊成一片更清楚；
 * 3. 这块像素缓冲可以直接当**存档预览图**（12×6×4 = 288 字节）。
 *
 * ## 为什么这个类不认识「城市」
 *
 * 它只认三样东西：格子值数组、调色板、几个标记点。
 * 「住宅是蓝色、农田是绿色、市政厅是金色」属于玩法知识，由调用方通过 `spec` 注入。
 * 这样换个玩法（或者画一张无关的网格地图）这个文件一行都不用改。
 *
 * ## 为什么不放进 Vue 的响应式
 *
 * 像素数据进 reactive 会被 Proxy 包一层，每次读都要过 trap。
 * 这里只把「是否脏」暴露成一个布尔给 UI，像素自己留在 typed array 里。
 */

/** 特殊格标记：优先级高于调色板，用于标出枢纽、选中项等。 */
export interface MinimapPin {
  /** 格子索引（`row * cols + col`）。 */
  readonly tile: number;
  /** 0xRRGGBB。 */
  readonly color: number;
}

export interface MinimapSpec {
  readonly cols: number;
  readonly rows: number;
  /** 格子值 → 0xRRGGBB。索引越界时用 `fallbackColor`。 */
  readonly palette: readonly number[];
  /** 特殊格着色，优先于 palette。构造时建索引，渲染时 O(1) 查。 */
  readonly pins?: readonly MinimapPin[];
  /**
   * 断供压暗色，不给则不画断供层。
   *
   * 断供是**派生状态**，单独存一层而不是直接改 `cells`：
   * `cells` 是经济层的投影，往里写派生状态等于制造第二份真相。
   */
  readonly blockedTint?: number;
  /** 表示「空格」的格子值。断供层只画在非空格上，默认 0。 */
  readonly emptyValue?: number;
  /** 放大倍数，仅作为目标 canvas 的尺寸建议值。默认 12。 */
  readonly scale?: number;
  /** 调色板查不到时的兜底色。默认纯黑。 */
  readonly fallbackColor?: number;
}

const DEFAULT_SCALE = 12;
const DEFAULT_FALLBACK = 0x000000;

function channels(color: number, out: Uint8Array, at: number): void {
  out[at] = (color >> 16) & 0xff;
  out[at + 1] = (color >> 8) & 0xff;
  out[at + 2] = color & 0xff;
  out[at + 3] = 0xff;
}

export class Minimap {
  /** 缩略图像素（RGBA，cols × rows）。存档预览直接用它。 */
  readonly pixels: Uint8Array;
  readonly cols: number;
  readonly rows: number;

  private readonly cells: Int8Array;
  private readonly blocked: Uint8Array;
  /** `setBlockedTiles` 的复用缓冲，避免每次调用都分配一整块。 */
  private readonly nextMask: Uint8Array;
  /** 每个格子的 pin 颜色，-1 表示没有 pin。用 Int32Array 而不是 Map：查得更快，也不依赖遍历序。 */
  private readonly pinColor: Int32Array;
  private readonly spec: MinimapSpec;
  private dirty = true;
  private frames = 0;
  private sourceCanvas: HTMLCanvasElement | null = null;

  constructor(spec: MinimapSpec, cells: Int8Array) {
    const count = spec.cols * spec.rows;
    if (cells.length < count) {
      throw new RangeError(`Minimap: cells 长度 ${cells.length} 小于 ${spec.cols}×${spec.rows}=${count}`);
    }
    this.spec = spec;
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.cells = cells;
    this.pixels = new Uint8Array(count * 4);
    this.blocked = new Uint8Array(count);
    this.nextMask = new Uint8Array(count);
    this.pinColor = new Int32Array(count).fill(-1);
    for (const pin of spec.pins ?? []) {
      if (pin.tile >= 0 && pin.tile < count) this.pinColor[pin.tile] = pin.color;
    }
    this.invalidate();
  }

  get tileCount(): number {
    return this.cols * this.rows;
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

  /** 标记某地块上的建筑断供。返回是否真的变化了。 */
  setBlocked(tile: number, on: boolean): boolean {
    if (tile < 0 || tile >= this.tileCount) return false;
    const next = on ? 1 : 0;
    if (this.blocked[tile] === next) return false;
    this.blocked[tile] = next;
    this.dirty = true;
    return true;
  }

  /**
   * 一次性刷新断供图层，返回是否有变化。
   *
   * 用一块复用的 `nextMask` 缓冲而不是每次 `new Uint8Array(tileCount)`：
   * 后者每次调用都要分配 + 清零一整块，10Hz 下就是每秒 10 次垃圾。
   * 这里先在两块掩码之间做 diff，只有真变了才重绘。
   */
  setBlockedTiles(tiles: readonly number[]): boolean {
    const next = this.nextMask;
    next.fill(0);
    for (const tile of tiles) {
      if (tile >= 0 && tile < this.tileCount) next[tile] = 1;
    }
    let changed = false;
    for (let tile = 0; tile < this.tileCount; tile += 1) {
      const value = next[tile] as number;
      if (value !== this.blocked[tile]) {
        this.blocked[tile] = value;
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
    const palette = this.spec.palette;
    const tint = this.spec.blockedTint;
    const empty = this.spec.emptyValue ?? 0;
    const fallback = this.spec.fallbackColor ?? DEFAULT_FALLBACK;
    for (let tile = 0; tile < this.tileCount; tile += 1) {
      const at = tile * 4;
      const pin = this.pinColor[tile] as number;
      if (pin >= 0) {
        channels(pin, bytes, at);
        continue;
      }
      const kind = this.cells[tile] as number;
      if (tint !== undefined && this.blocked[tile] === 1 && kind !== empty) {
        channels(tint, bytes, at);
        continue;
      }
      channels(palette[kind] ?? fallback, bytes, at);
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
    const scale = this.spec.scale ?? DEFAULT_SCALE;
    const width = (target.width = this.cols * scale);
    const height = (target.height = this.rows * scale);
    if (width === 0 || height === 0) return false;

    const ctx = target.getContext('2d');
    if (ctx === null) return false;

    // 即使不脏也要保证首帧有内容
    this.render();

    const source = this.sourceCanvas ?? this.makeSourceCanvas();
    this.sourceCanvas = source;
    const sctx = source.getContext('2d');
    if (sctx === null) return false;
    const image = sctx.createImageData(this.cols, this.rows);
    image.data.set(this.pixels);
    sctx.putImageData(image, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, this.cols, this.rows, 0, 0, width, height);
    return true;
  }

  /** 缩略图的 base64 PNG data URL（存档预览、分享截图用）。 */
  toDataUrl(): string | null {
    if (typeof document === 'undefined') return null;
    this.render();
    const canvas = this.makeSourceCanvas();
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const image = ctx.createImageData(this.cols, this.rows);
    image.data.set(this.pixels);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  private makeSourceCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.cols;
    canvas.height = this.rows;
    return canvas;
  }
}
