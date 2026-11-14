/**
 * Three.js 侧的资源装载器 —— 真正碰网络与解码器的那一层。
 *
 * ## 解码器为什么必须外置
 *
 * `basis_transcoder`（576KB）与 `draco_decoder`（340KB）合计约 900KB。
 * 打进主包意味着「只想画几个方块的小游戏」也要先下 1MB 才能出现画面。
 * 所以这里只在你**真的要加载压缩资源**时才 `import()` 加载器，
 * 解码器 wasm 由调用方托管（默认放 `public/decoders/`），并按需 fetch。
 *
 * 代价是这些文件必须由部署方提供 —— 引擎不替你搬。`docs/ASSETS.md`
 * 写了怎么从 `three/examples/jsm/libs/` 拷过来。
 *
 * ## 为什么加载器实例要复用
 *
 * `KTX2Loader` 内部会起 worker 池，`DRACOLoader` 也是。
 * 每加载一个资源就 new 一个，等于每次起一组 worker ——
 * 移动端上这是肉眼可见的卡顿与内存峰值。所以这里懒创建、全局复用，
 * 直到 `dispose()`。
 */

import type * as THREE from 'three';
import { AssetCache, type AssetCacheStats } from './cache.js';
import type { AssetCapabilities } from './capability.js';
import { meshCandidates, resolveTextureChain } from './variants.js';

/** 解码器目录。必须以 `/` 结尾 —— three 内部是字符串拼接。 */
export interface DecoderPaths {
  /** `basis_transcoder.js` / `basis_transcoder.wasm` 所在目录。 */
  readonly basis: string;
  /** `draco_decoder.js` / `draco_decoder.wasm` 所在目录。 */
  readonly draco: string;
}

export interface ThreeAssetHostOptions {
  /** 用来给 KTX2Loader 做格式探测，也是纹理上传的目标。 */
  readonly renderer: THREE.WebGLRenderer;
  readonly decoderPaths: DecoderPaths;
  readonly caps: AssetCapabilities;
  /** 纹理/网格的缓存上限，默认各 64。 */
  readonly maxEntries?: number;
  /** 引用归零后的回收宽限期（毫秒），默认 5000。 */
  readonly graceMs?: number;
  /** 单张纹理的 `anisotropy` 上限，默认 1（移动端不建议开）。 */
  readonly maxAnisotropy?: number;
}

interface GridLike {
  dispose(): void;
}

export class ThreeAssetHost {
  readonly textures: AssetCache<THREE.Texture>;
  readonly meshes: AssetCache<THREE.Object3D>;
  /** 每次回退掉一个候选就 +1，诊断面板用来看「这台机器到底退了多少次」。 */
  private fallbacks = 0;
  private disposed = false;
  private ktx2Loader: unknown = null;
  private dracoLoader: unknown = null;
  private loaderFactory: LoaderFactory | null = null;
  private readonly options: ThreeAssetHostOptions;
  private readonly clock = (): number => performance.now();
  private readonly pendingGeometries = new Set<GridLike>();

  constructor(options: ThreeAssetHostOptions) {
    this.options = options;
    this.textures = new AssetCache<THREE.Texture>({
      // 兜底 loader：直接 acquire(url) 时把 key 当 URL 用（不套候选链）
      loader: (key) => this.loadOneTexture(key),
      dispose: (texture) => texture.dispose(),
      clock: this.clock,
      maxEntries: options.maxEntries ?? 64,
      graceMs: options.graceMs ?? 5000,
    });
    this.meshes = new AssetCache<THREE.Object3D>({
      loader: (key) => this.loadOneMesh(key, false),
      dispose: (object) => disposeObject(object),
      clock: this.clock,
      maxEntries: options.maxEntries ?? 64,
      graceMs: options.graceMs ?? 5000,
    });
  }

  get stats(): { readonly textures: AssetCacheStats; readonly meshes: AssetCacheStats; readonly fallbacks: number } {
    return { textures: this.textures.stats, meshes: this.meshes.stats, fallbacks: this.fallbacks };
  }

  /** 这张纹理的候选链（诊断/预加载用）。 */
  textureChain(base: string, legacy?: readonly string[]): string[] {
    return resolveTextureChain(base, this.options.caps, legacy);
  }

  /**
   * 加载一张纹理。`base` 可以带也可以不带扩展名。
   *
   * 走 `@tabby/assets` 的候选链：KTX2（能力允许才排）→ 未压缩。
   * 某一档失败就退下一档，并记一次 `fallbacks` ——
   * 这个数字比日志有用：它直接告诉你线上设备退化到了什么程度。
   */
  loadTexture(base: string, legacy?: readonly string[]): Promise<THREE.Texture> {
    const chain = this.textureChain(base, legacy);
    return this.textures.acquire(base, async () => {
      let lastError: unknown = null;
      for (let i = 0; i < chain.length; i += 1) {
        const url = chain[i] as string;
        try {
          const texture = await this.loadOneTexture(url);
          if (i > 0) this.fallbacks += 1;
          return texture;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`纹理 ${base} 全部候选都失败`);
    });
  }

  /**
   * 加载一个网格。`compressedUrl` 是 draco 压缩版（没有就传同一个 URL 也行）。
   *
   * 与纹理不同，DRACO 是容器内压缩，URL 不变 —— 所以「能不能解码」直接决定
   * 「能不能加载」。没有未压缩备用文件时，`caps.draco === false` 会直接抛。
   */
  loadMesh(compressedUrl: string, plainUrl: string | null = null): Promise<THREE.Object3D> {
    const chain = meshCandidates(compressedUrl, plainUrl, this.options.caps);
    return this.meshes.acquire(compressedUrl, async () => {
      let lastError: unknown = null;
      for (let i = 0; i < chain.length; i += 1) {
        const candidate = chain[i];
        if (candidate === undefined) continue;
        try {
          const object = await this.loadOneMesh(candidate.url, candidate.compressed);
          if (i > 0) this.fallbacks += 1;
          return object;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`网格 ${compressedUrl} 全部候选都失败`);
    });
  }

  /** 回收已过宽限期的资源。建议 1Hz 调一次。 */
  collect(): number {
    return this.textures.collect() + this.meshes.collect();
  }

  /** 释放所有加载器（worker 池）与缓存。视图销毁时必须调用。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textures.clear();
    this.meshes.clear();
    // three 的 loader 类型里 dispose 是可选的历史包袱，这里按结构判断
    const ktx2 = this.ktx2Loader as { dispose?: () => void } | null;
    if (typeof ktx2?.dispose === 'function') ktx2.dispose();
    const draco = this.dracoLoader as { dispose?: () => void } | null;
    if (typeof draco?.dispose === 'function') draco.dispose();
    this.ktx2Loader = null;
    this.dracoLoader = null;
    for (const geometry of this.pendingGeometries) geometry.dispose();
    this.pendingGeometries.clear();
  }

  private async loadOneTexture(url: string): Promise<THREE.Texture> {
    const isKtx2 = url.toLowerCase().endsWith('.ktx2');
    const factory = await this.factory();
    if (isKtx2) {
      const loader = await this.ensureKtx2();
      const texture = await loader.loadAsync(url);
      texture.anisotropy = this.options.maxAnisotropy ?? 1;
      // KTX2 自带 mip 链与 sRGB 标记，再让 three 生成 mip 会覆盖压缩数据
      texture.needsUpdate = true;
      return texture;
    }
    return factory.loadLegacyTexture(url);
  }

  private async loadOneMesh(url: string, compressed: boolean): Promise<THREE.Object3D> {
    const factory = await this.factory();
    const draco = compressed ? await this.ensureDraco() : null;
    return factory.loadGltf(url, draco);
  }

  private async ensureKtx2(): Promise<{ loadAsync(url: string): Promise<THREE.Texture> }> {
    if (this.ktx2Loader !== null) return this.ktx2Loader as { loadAsync(url: string): Promise<THREE.Texture> };
    const factory = await this.factory();
    const loader = await factory.createKtx2(this.options.renderer, this.options.decoderPaths.basis);
    this.ktx2Loader = loader;
    return loader;
  }

  private async ensureDraco(): Promise<unknown> {
    if (this.dracoLoader !== null) return this.dracoLoader;
    const factory = await this.factory();
    const loader = await factory.createDraco(this.options.decoderPaths.draco);
    this.dracoLoader = loader;
    return loader;
  }

  private async factory(): Promise<LoaderFactory> {
    if (this.loaderFactory !== null) return this.loaderFactory;
    const module = await import('./loader-factory.js');
    this.loaderFactory = new module.ThreeLoaderFactory();
    return this.loaderFactory;
  }
}

/** 把 three 的加载器封装成可替换的接口：测试里能塞假实现，Node 里不会碰真加载器。 */
export interface LoaderFactory {
  createKtx2(renderer: THREE.WebGLRenderer, transcoderPath: string): Promise<{ loadAsync(url: string): Promise<THREE.Texture>; dispose?(): void }>;
  createDraco(decoderPath: string): Promise<unknown>;
  loadLegacyTexture(url: string): Promise<THREE.Texture>;
  loadGltf(url: string, draco: unknown): Promise<THREE.Object3D>;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as unknown as { geometry?: GridLike; material?: GridLike | GridLike[] };
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const item of material) item.dispose();
    else material?.dispose();
  });
}
