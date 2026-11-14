import { chunkPath } from './chunk.js';
import { HeightField } from './height-field.js';
import { decodeR16, rangeOf } from './r16.js';
import type { TerrainChunk, TerrainMeta } from './types.js';

export interface TerrainLoaderOptions {
  /** 产物根目录 URL，末尾不带斜杠。 */
  readonly baseUrl: string;
  /** 使用的 LOD 级别，缺省 0（原图）。 */
  readonly lod?: number;
  /** 分块缓存上限，超出按 LRU 淘汰。 */
  readonly maxCachedChunks?: number;
  /** 自定义 fetch（Node 测试或带鉴权的场景）。 */
  readonly fetchImpl?: typeof fetch;
}

/**
 * 地形加载器。
 *
 * 大图（4096² 以上）不要 loadAll()，按 chunk 流式取：单个 128×128 块只有 32KB，
 * 而 4096² 整图是 32MB，移动端一次吃掉会触发内存告警。
 */
export class TerrainLoader {
  readonly baseUrl: string;
  readonly lod: number;
  private readonly maxCached: number;
  private readonly fetchImpl: typeof fetch;
  private meta: TerrainMeta | null = null;
  private readonly cache = new Map<string, TerrainChunk>();

  constructor(options: TerrainLoaderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.lod = options.lod ?? 0;
    this.maxCached = options.maxCachedChunks ?? 64;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async loadMeta(): Promise<TerrainMeta> {
    if (this.meta !== null) return this.meta;
    const res = await this.fetchImpl(`${this.baseUrl}/meta.json`);
    if (!res.ok) throw new Error(`[tabby/terrain] meta.json 加载失败：HTTP ${res.status}`);
    const meta = (await res.json()) as TerrainMeta;
    if (meta.version !== 1) {
      throw new Error(`[tabby/terrain] 不支持的 meta 版本 ${String(meta.version)}，需要迁移`);
    }
    this.meta = meta;
    return meta;
  }

  /** 加载单个分块。同一块重复请求会命中缓存。 */
  async loadChunk(cx: number, cy: number): Promise<TerrainChunk> {
    const meta = await this.loadMeta();
    if (meta.chunks === null) {
      throw new Error('[tabby/terrain] 该产物为整图模式，请用 loadAll()');
    }
    const key = `${this.lod}:${cx}:${cy}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // 命中即刷新 LRU 顺序
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const path = chunkPath(meta.chunks.pathTemplate, cx, cy, this.lod);
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`);
    if (!res.ok) throw new Error(`[tabby/terrain] 分块 ${path} 加载失败：HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const size = meta.chunks.chunkSize;
    const chunk: TerrainChunk = { cx, cy, size, data: decodeR16(bytes, size * size) };

    this.cache.set(key, chunk);
    this.evict();
    return chunk;
  }

  private evict(): void {
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) return;
      this.cache.delete(oldest.value);
    }
  }

  /** 整图加载。只建议用于小图（≤2048²）或离线校验。 */
  async loadAll(): Promise<HeightField> {
    const meta = await this.loadMeta();

    // 先看该 LOD 有没有整图文件：低阶 LOD 是单文件，只有 LOD0 才是分块。
    const lodEntry = meta.lods.find((l) => l.level === this.lod);
    if (lodEntry?.file !== undefined) {
      const res = await this.fetchImpl(`${this.baseUrl}/${lodEntry.file}`);
      if (!res.ok) throw new Error(`[tabby/terrain] ${lodEntry.file} 加载失败：HTTP ${res.status}`);
      const data = decodeR16(new Uint8Array(await res.arrayBuffer()), lodEntry.width * lodEntry.height);
      return new HeightField(data, lodEntry.width, lodEntry.height, meta.cellSizeMeters * lodEntry.step, rangeOf(meta));
    }

    if (meta.chunks === null) {
      throw new Error(`[tabby/terrain] 该产物无分块也无 LOD${this.lod} 整图文件`);
    }
    const { chunkSize, chunksX, chunksY } = meta.chunks;
    const data = new Uint16Array(meta.width * meta.height);
    for (let cy = 0; cy < chunksY; cy += 1) {
      for (let cx = 0; cx < chunksX; cx += 1) {
        const chunk = await this.loadChunk(cx, cy);
        for (let y = 0; y < chunkSize; y += 1) {
          const dstRow = cy * chunkSize + y;
          if (dstRow >= meta.height) break;
          for (let x = 0; x < chunkSize; x += 1) {
            const dstCol = cx * chunkSize + x;
            if (dstCol >= meta.width) break;
            data[dstRow * meta.width + dstCol] = chunk.data[y * chunkSize + x] ?? 0;
          }
        }
      }
    }
    return new HeightField(data, meta.width, meta.height, meta.cellSizeMeters, rangeOf(meta));
  }

  /** 已缓存块数，用于诊断面板。 */
  get cachedChunks(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
