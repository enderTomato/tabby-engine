/**
 * 真实的 three 加载器实现 —— 与 `three-host.ts` 分开是为了让那边能测。
 *
 * 这个文件里的每一条 `import()` 都是**动态**的：
 * 打进主包意味着所有游戏都要为「可能用到的压缩格式」付 900KB。
 * 分离之后，`three-host.ts` 只依赖接口，`node --test` 里 import 它不会拉起浏览器专用的东西。
 */

import type * as THREE from 'three';
import type { LoaderFactory } from './three-host.js';

type Ktx2Like = { loadAsync(url: string): Promise<THREE.Texture>; dispose?(): void; detectSupport?(renderer: THREE.WebGLRenderer): unknown };

export class ThreeLoaderFactory implements LoaderFactory {
  async createKtx2(renderer: THREE.WebGLRenderer, transcoderPath: string): Promise<Ktx2Like> {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const loader = new KTX2Loader();
    // detectSupport 必须在 load 之前调：它决定 transcode 的目标格式（ASTC/ETC2/BC/…）
    loader.detectSupport(renderer);
    loader.setTranscoderPath(transcoderPath);
    return loader as unknown as Ktx2Like;
  }

  async createDraco(decoderPath: string): Promise<unknown> {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const loader = new DRACOLoader();
    loader.setDecoderPath(decoderPath);
    // 明确只要 wasm：不再回退到 asm.js（多下的那 300KB 在 4G 手机上没有意义）
    loader.setDecoderConfig({ type: 'wasm' });
    return loader;
  }

  async loadLegacyTexture(url: string): Promise<THREE.Texture> {
    const { TextureLoader } = await import('three');
    const loader = new TextureLoader();
    return loader.loadAsync(url);
  }

  async loadGltf(url: string, draco: unknown): Promise<THREE.Object3D> {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    if (draco !== null && draco !== undefined) {
      loader.setDRACOLoader(draco as Parameters<typeof loader.setDRACOLoader>[0]);
    }
    const gltf = await loader.loadAsync(url);
    return gltf.scene;
  }
}
