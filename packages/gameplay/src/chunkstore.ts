/**
 * 分块存档与流式加载。
 *
 * ## 为什么需要「块」这一层
 *
 * 现在的 12×6 地图小到整张塞进内存都无所谓，但引擎要支持的是「几十万格的地形」。
 * 那种规模下有两个硬约束：
 *
 * 1. **存档不能一次性全读**。手机上一个 50MB 的地形存档 base64 之后是 66MB，
 *    解析期间主线程直接卡死 2~3 秒。分块之后，玩家落地的那一块先读，其余按需读。
 * 2. **改动必须能增量落盘**。玩家只动了一块地，重写整份存档既慢又伤闪存。
 *
 * ## 文件格式
 *
 * ```
 * 头部（固定 24 字节）
 *   magic   4B  "TBCK"
 *   version 2B  小端
 *   cols    2B  块宽（格）
 *   rows    2B  块高（格）
 *   chunkW  2B
 *   chunkH  2B
 *   count   4B  块数量
 *   reserved 8B
 * 目录（count × 16 字节）
 *   key     4B  (cx << 16) | cy
 *   offset  4B  数据区起始（相对文件头，绝对偏移 = 24 + 16*count + offset）
 *   length  4B
 *   crc     4B  FNV-1a，校验数据没被截断
 * 数据区：各块依次排列，块内是 `cells`(1B/格) + `entityIds`(4B/格，可选)
 * ```
 *
 * 目录在前、数据在后，所以**读单块不需要扫全文件**：seek 到目录，找到 offset，
 * 直接读那一段。这是「流式」的全部秘密，没有更复杂的东西。
 *
 * ## 为什么 CRC 用 FNV-1a 而不是 CRC32 查表
 *
 * 存档损坏的主要形态是「写到一半被杀进程」，表现为结尾截断，用任何校验和都能发现。
 * FNV-1a 三行代码、无查表、无初始化，比 CRC32 少 1KB 表和一个乘除循环。
 * 它不是为了防篡改 —— 防篡改需要签名，那是另一个量级的事。
 */

import { GRID_COLS, GRID_ROWS, TILE_COUNT } from './city.js';

const MAGIC = 0x4b434254; // "TBCK" little-endian
const VERSION = 1;
const HEADER_BYTES = 24;
const DIR_ENTRY_BYTES = 16;

/** 块尺寸（格）。取 4×3：一张 12×6 地图正好切 3×2 = 6 块，方便断言。 */
export const CHUNK_W = 4;
export const CHUNK_H = 3;
export const CHUNKS_X = Math.ceil(GRID_COLS / CHUNK_W);
export const CHUNKS_Y = Math.ceil(GRID_ROWS / CHUNK_H);

export interface ChunkKey {
  readonly cx: number;
  readonly cy: number;
}

export function chunkKey(cx: number, cy: number): number {
  return (cx << 16) | cy;
}

export function chunkOfTile(tile: number): ChunkKey {
  const col = tile % GRID_COLS;
  const row = (tile - col) / GRID_COLS;
  return { cx: Math.floor(col / CHUNK_W), cy: Math.floor(row / CHUNK_H) };
}

/** 一块的原始数据：格子类型 + 实体 id。 */
export interface ChunkPayload {
  readonly key: number;
  readonly cells: Int8Array;
  readonly entities: Int32Array;
}

function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number;
    // imul 保证 32 位精确乘法，普通 `*` 在跨越 2^53 时会丢低位
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 把整张地图切成块。
 *
 * `entities` 可选：不需要「哪一格是哪栋楼」的存档（比如只存地形高度）可以省略。
 */
export function splitChunks(cells: Int8Array, entities?: Int32Array): ChunkPayload[] {
  const chunks: ChunkPayload[] = [];
  for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
    for (let cx = 0; cx < CHUNKS_X; cx += 1) {
      const w = Math.min(CHUNK_W, GRID_COLS - cx * CHUNK_W);
      const h = Math.min(CHUNK_H, GRID_ROWS - cy * CHUNK_H);
      const size = w * h;
      const payloadCells = new Int8Array(size);
      const payloadEntities = new Int32Array(size).fill(-1);
      for (let r = 0; r < h; r += 1) {
        for (let c = 0; c < w; c += 1) {
          const at = r * w + c;
          const tile = (cy * CHUNK_H + r) * GRID_COLS + (cx * CHUNK_W + c);
          payloadCells[at] = cells[tile] as number;
          if (entities !== undefined) payloadEntities[at] = entities[tile] as number;
        }
      }
      chunks.push({ key: chunkKey(cx, cy), cells: payloadCells, entities: payloadEntities });
    }
  }
  return chunks;
}

/**
 * 打包成一份分块存档。
 *
 * `onlyDirty` 为 true 时只写传入的块（增量存档）：调用方传进来的就是脏块列表，
 * 不需要再算一遍 —— 谁是脏的只有调用方知道（见 `ChunkStreamer.dirtyKeys`）。
 */
export function packChunks(chunks: readonly ChunkPayload[]): Uint8Array {
  const count = chunks.length;
  const parts: Uint8Array[] = [];
  let dataBytes = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk.cells.length + chunk.entities.length * 4);
    bytes.set(chunk.cells, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset + chunk.cells.length);
    for (let i = 0; i < chunk.entities.length; i += 1) {
      view.setInt32(i * 4, chunk.entities[i] as number, true);
    }
    parts.push(bytes);
    dataBytes += bytes.length;
  }

  const total = HEADER_BYTES + count * DIR_ENTRY_BYTES + dataBytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, GRID_COLS, true);
  view.setUint16(8, GRID_ROWS, true);
  view.setUint16(10, CHUNK_W, true);
  view.setUint16(12, CHUNK_H, true);
  view.setUint32(14, count, true);

  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const chunk = chunks[i] as ChunkPayload;
    const bytes = parts[i] as Uint8Array;
    const dirAt = HEADER_BYTES + i * DIR_ENTRY_BYTES;
    view.setUint32(dirAt, chunk.key, true);
    view.setUint32(dirAt + 4, offset, true);
    view.setUint32(dirAt + 8, bytes.length, true);
    view.setUint32(dirAt + 12, fnv1a(bytes), true);
    out.set(bytes, HEADER_BYTES + count * DIR_ENTRY_BYTES + offset);
    offset += bytes.length;
  }
  return out;
}

export interface ChunkDirectoryEntry {
  readonly key: number;
  readonly offset: number;
  readonly length: number;
  readonly crc: number;
}

export interface ChunkArchiveHeader {
  readonly version: number;
  readonly cols: number;
  readonly rows: number;
  readonly chunkW: number;
  readonly chunkH: number;
  readonly directory: readonly ChunkDirectoryEntry[];
}

/** 只读目录，不碰数据区。字节大小固定，随便调都很快。 */
export function readDirectory(bytes: Uint8Array): ChunkArchiveHeader {
  if (bytes.length < HEADER_BYTES) throw new Error('[tabby/demo] 存档太短，连文件头都不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) throw new Error(`[tabby/demo] 不是分块存档（magic=0x${magic.toString(16)}）`);
  const version = view.getUint16(4, true);
  if (version > VERSION) throw new Error(`[tabby/demo] 存档版本 ${version} 过新`);

  const count = view.getUint32(14, true);
  const need = HEADER_BYTES + count * DIR_ENTRY_BYTES;
  if (bytes.length < need) throw new Error('[tabby/demo] 目录被截断');

  const directory: ChunkDirectoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_BYTES + i * DIR_ENTRY_BYTES;
    directory.push({
      key: view.getUint32(at, true),
      offset: view.getUint32(at + 4, true),
      length: view.getUint32(at + 8, true),
      crc: view.getUint32(at + 12, true),
    });
  }
  return {
    version,
    cols: view.getUint16(6, true),
    rows: view.getUint16(8, true),
    chunkW: view.getUint16(10, true),
    chunkH: view.getUint16(12, true),
    directory,
  };
}

/**
 * 读单块。校验失败抛错 —— 静默返回空块会变成「读档后地图凭空少一块」。
 *
 * `header` 可以传入复用（批量读时避免每次都扫一遍目录）。
 */
export function readChunk(
  bytes: Uint8Array,
  entry: ChunkDirectoryEntry,
  header?: ChunkArchiveHeader,
): ChunkPayload {
  const known = header ?? readDirectory(bytes);
  const base = HEADER_BYTES + known.directory.length * DIR_ENTRY_BYTES;
  const start = base + entry.offset;
  const end = start + entry.length;
  if (start < 0 || end > bytes.length) {
    throw new Error(`[tabby/demo] 块 0x${entry.key.toString(16)} 越界（${start}..${end}/${bytes.length}）`);
  }
  const slice = bytes.subarray(start, end);
  if (fnv1a(slice) !== entry.crc) {
    throw new Error(`[tabby/demo] 块 0x${entry.key.toString(16)} 校验失败（存档被截断或损坏）`);
  }
  // 块内布局：cells(n 字节) + entities(n × 4 字节)，所以总长一定是 5n
  if (entry.length % 5 !== 0) {
    throw new Error(`[tabby/demo] 块 0x${entry.key.toString(16)} 长度 ${entry.length} 不是 5 的倍数`);
  }
  const cellsLen = entry.length / 5;
  const cells = new Int8Array(slice.subarray(0, cellsLen));
  const entities = new Int32Array((slice.length - cellsLen) >> 2);
  const view = new DataView(slice.buffer, slice.byteOffset + cellsLen);
  for (let i = 0; i < entities.length; i += 1) entities[i] = view.getInt32(i * 4, true);
  return { key: entry.key, cells, entities };
}

/**
 * 流式加载调度器。
 *
 * 职责只有一件事：**决定「现在应该常驻哪些块」**，并按帧预算分批加载/卸载。
 * 它不碰经济层状态 —— 块数据是存档的读缓存，不是世界真相。
 *
 * 调度策略：
 * - 需要常驻的块 = 中心块 + 半径 `radius` 内的块（切比雪夫距离）；
 * - 按距离排序后取前 `budget` 个加载；
 * - 离开半径的块本轮不立刻卸载，等 `unloadGraceFrames` 帧后才丢，
 *   否则玩家在块边界来回走动会反复加载/卸载同一块。
 */
export class ChunkStreamer {
  private readonly archive: Uint8Array;
  private readonly header: ChunkArchiveHeader;
  private readonly loaded = new Set<number>();
  private readonly cooldown = new Map<number, number>();
  private readonly dirty = new Set<number>();
  private readonly payloads = new Map<number, ChunkPayload>();
  private center: ChunkKey = { cx: 0, cy: 0 };
  private radius = 1;
  private budget = 1;
  private unloadGraceFrames = 60;
  private loads = 0;
  private unloads = 0;

  constructor(archive: Uint8Array) {
    this.archive = archive;
    this.header = readDirectory(archive);
  }

  get chunkCount(): number {
    return this.header.directory.length;
  }

  get residentCount(): number {
    return this.loaded.size;
  }

  get loadCount(): number {
    return this.loads;
  }

  get unloadCount(): number {
    return this.unloads;
  }

  /** 已常驻的块 key 列表（升序，确定性）。 */
  residentKeys(): number[] {
    return Array.from(this.loaded).sort((a, b) => a - b);
  }

  /** 设置关注中心（通常是相机/玩家所在格）。 */
  focus(tile: number): void {
    this.center = chunkOfTile(tile);
  }

  configure(options: { radius?: number; budget?: number; unloadGraceFrames?: number } = {}): void {
    if (options.radius !== undefined) this.radius = Math.max(0, Math.floor(options.radius));
    if (options.budget !== undefined) this.budget = Math.max(1, Math.floor(options.budget));
    if (options.unloadGraceFrames !== undefined) {
      this.unloadGraceFrames = Math.max(0, Math.floor(options.unloadGraceFrames));
    }
  }

  /** 需要常驻的块，按「离中心由近到远」排序。 */
  wanted(): number[] {
    const list: { key: number; distance: number }[] = [];
    for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
      for (let cx = 0; cx < CHUNKS_X; cx += 1) {
        const distance = Math.max(Math.abs(cx - this.center.cx), Math.abs(cy - this.center.cy));
        if (distance > this.radius) continue;
        list.push({ key: chunkKey(cx, cy), distance });
      }
    }
    // 距离相同按 key 升序：不能让 Map/Set 的遍历序决定加载顺序（确定性红线）
    list.sort((a, b) => a.distance - b.distance || a.key - b.key);
    return list.map((item) => item.key);
  }

  /**
   * 推进一帧。返回本帧加载/卸载的块数。
   *
   * 每帧最多加载 `budget` 块，所以「一次传送跨半张地图」不会在一帧里读完所有块。
   */
  step(): { readonly loaded: number; readonly unloaded: number } {
    const want = this.wanted();
    let loaded = 0;
    for (const key of want) {
      if (loaded >= this.budget) break;
      if (this.loaded.has(key)) continue;
      this.loadOne(key);
      loaded += 1;
    }

    let unloaded = 0;
    if (this.unloadGraceFrames === 0) {
      for (const key of this.residentKeys()) {
        if (want.includes(key)) continue;
        this.loaded.delete(key);
        this.payloads.delete(key);
        unloaded += 1;
      }
    } else {
      // 先给「不需要但还常驻」的块上冷却，冷却到期才真正卸载
      for (const key of this.residentKeys()) {
        if (want.includes(key)) {
          this.cooldown.delete(key);
          continue;
        }
        const left = (this.cooldown.get(key) ?? this.unloadGraceFrames) - 1;
        if (left > 0) {
          this.cooldown.set(key, left);
          continue;
        }
        this.cooldown.delete(key);
        this.loaded.delete(key);
        this.payloads.delete(key);
        unloaded += 1;
      }
    }
    this.unloads += unloaded;
    return { loaded, unloaded };
  }

  /** 取已常驻的块数据；未常驻返回 null（调用方应当先 `step` 或按需 `load(key)`）。 */
  get(key: number): ChunkPayload | null {
    return this.payloads.get(key) ?? null;
  }

  /** 同步加载单块（传送、点选远景时用，会绕过预算）。返回是否成功。 */
  load(key: number): boolean {
    if (this.loaded.has(key)) return true;
    return this.loadOne(key);
  }

  /** 标记某块被修改过（增量存档用）。 */
  markDirty(key: number): void {
    this.dirty.add(key);
  }

  /** 脏块列表（升序）。 */
  dirtyKeys(): number[] {
    return Array.from(this.dirty).sort((a, b) => a - b);
  }

  /** 只打包脏块；没有脏块返回空数组。 */
  packDirty(): Uint8Array {
    const keys = this.dirtyKeys();
    const chunks: ChunkPayload[] = [];
    for (const key of keys) {
      const payload = this.payloads.get(key);
      if (payload !== undefined) chunks.push(payload);
    }
    return packChunks(chunks);
  }

  clearDirty(): void {
    this.dirty.clear();
  }

  private loadOne(key: number): boolean {
    const entry = this.header.directory.find((item) => item.key === key);
    if (entry === undefined) return false;
    try {
      this.payloads.set(key, readChunk(this.archive, entry, this.header));
    } catch {
      // 单块坏了不该拖垮整张地图：跳过它，其余块照常加载
      return false;
    }
    this.loaded.add(key);
    this.cooldown.delete(key);
    this.loads += 1;
    return true;
  }
}

/** 读出全部块。单块损坏时跳过该块（不让一块坏档拖垮整张地图）。 */
export function readAllChunks(bytes: Uint8Array): ChunkPayload[] {
  const header = readDirectory(bytes);
  const out: ChunkPayload[] = [];
  for (const entry of header.directory) {
    try {
      out.push(readChunk(bytes, entry, header));
    } catch {
      // 坏块跳过：调用方拿到的地图会在那一块保持默认值，比整体失败更有用
    }
  }
  return out;
}

/** 从块数据拼回整张地图。读档时用；大世界下不推荐（故意做成显式的慢路径）。 */
export function mergeChunks(chunks: readonly ChunkPayload[]): { cells: Int8Array; entities: Int32Array } {
  const cells = new Int8Array(TILE_COUNT);
  const entities = new Int32Array(TILE_COUNT).fill(-1);
  for (const chunk of chunks) {
    const cx = (chunk.key >> 16) & 0xffff;
    const cy = chunk.key & 0xffff;
    const w = Math.min(CHUNK_W, GRID_COLS - cx * CHUNK_W);
    const h = Math.min(CHUNK_H, GRID_ROWS - cy * CHUNK_H);
    for (let r = 0; r < h; r += 1) {
      for (let c = 0; c < w; c += 1) {
        const at = r * w + c;
        const tile = (cy * CHUNK_H + r) * GRID_COLS + (cx * CHUNK_W + c);
        cells[tile] = chunk.cells[at] as number;
        entities[tile] = chunk.entities[at] as number;
      }
    }
  }
  return { cells, entities };
}
