/**
 * 探针：资源加载与降级。
 *
 * 这条链路最容易被写成一个「能加载就万事大吉」的假实现。真正难的是三件事，
 * 这个探针把它们分别摆出来：
 *
 * 1. **能力探测 → 候选链 → 实际加载** 是三步，不是一步。
 *    面板上直接列出「这台机器会走哪条链」，加载完再对一次账 ——
 *    如果链是 `crate.ktx2` 但实际加载了 `crate.png`，那 `fallbacks` 必须是 1。
 * 2. **解码器不进主包**。basis 527KB + draco 285KB 全在 `public/decoders/`，
 *    只在真的加载压缩资源时才 fetch。断网/删目录时应当**降级到未压缩版而不是白屏**。
 * 3. **引用计数 + 宽限期回收**。同一张纹理被两处用，释放一处不能真的 dispose；
 *    释放到底也要等宽限期过去，因为下一帧可能又要点它（这正是"切场景时纹理闪一下"的成因）。
 *
 * 资产是 `tools/make-test-assets.mjs` 现场生成的极小 ktx2/png/glb/glb，真实可解码。
 */

import * as THREE from 'three';
import {
  AssetCache,
  ThreeAssetHost,
  conservativeCapabilities,
  describeCapabilities,
  meshCandidates,
  probeAssetCapabilities,
  resolveTextureChain,
  textureCandidates,
  type AssetCapabilities,
} from '@tabby/assets';
import { addButton, addRow, attachOrbit, createThreeStage, makeControls, makeOverlay, type ThreeStage } from './shared.js';
import { batchLine, timeBatch, Timing, type BenchResult, type Probe, type ProbeContext } from '../types.js';

const TEXTURE_BASE = './test-assets/crate';
const MESH_URL = './test-assets/crate.glb';
const MESH_PLAIN = './test-assets/crate-plain.glb';
const DECODERS = { basis: './decoders/', draco: './decoders/' };

export function createAssetsProbe(): Probe {
  let stage: ThreeStage | null = null;
  let host: ThreeAssetHost | null = null;
  let caps: AssetCapabilities | null = null;
  let detachOrbit: (() => void) | null = null;
  let plane: THREE.Mesh | null = null;
  let loadedMesh: THREE.Object3D | null = null;
  let refs = 0;
  let forceLow = false;
  let rowCaps: HTMLSpanElement | null = null;
  let rowChain: HTMLSpanElement | null = null;
  let rowActual: HTMLSpanElement | null = null;
  let rowLive: HTMLSpanElement | null = null;
  let rowFallback: HTMLSpanElement | null = null;
  let rowLoadTime: HTMLSpanElement | null = null;
  let rowDecoderCost: HTMLSpanElement | null = null;
  const loadTiming = new Timing(20);
  /** 首次加载（含解码器下载与实例化）单独记，它和命中缓存不是一个量级。 */
  let coldMs = 0;

  function rebuildHost(context: ProbeContext): void {
    if (stage === null) return;
    host?.dispose();
    host = new ThreeAssetHost({
      renderer: stage.renderer,
      decoderPaths: DECODERS,
      caps: forceLow ? conservativeCapabilities('探针强制降级') : (caps as AssetCapabilities),
      maxEntries: 8,
      // 宽限期压到 900ms：探针里要能几秒内看见「释放 → 待回收 → 真回收」三步，
      // 生产默认是 5000ms（切场景的抖动窗口）。
      graceMs: 900,
    });
    refs = 0;
    context.log(forceLow ? '已切到「强制降级」：候选链只剩未压缩版' : '已恢复真实能力探测');
  }

  function renderChain(): void {
    if (caps === null) return;
    const texture = resolveTextureChain(TEXTURE_BASE, caps, ['png']);
    const mesh = meshCandidates(MESH_URL, MESH_PLAIN, caps);
    if (rowChain !== null) {
      rowChain.textContent = `${texture.map((url) => url.split('/').pop() ?? '').join(' → ')}  |  ${mesh.map((item) => item.url.split('/').pop() ?? '').join(' → ')}`;
    }
  }

  return {
    id: 'assets',
    title: '资源加载 / 降级',
    summary: '能力探测 → 候选链 → 真加载；解码器不进主包，压缩格式不可用时降级到未压缩',
    group: '渲染',

    mount(context) {
      stage = createThreeStage(context.host);
      detachOrbit = attachOrbit(stage.canvas, stage.camera, new THREE.Vector3(0, 1.2, 0));
      stage.camera.position.set(3.2, 2.4, 4.2);
      stage.camera.lookAt(0, 1.2, 0);

      // 用一个真的 WebGL2 上下文来探测，而不是读 `navigator.userAgent` ——
      // 同名 GPU 在不同驱动上支持的压缩格式可能完全不同
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2');
      caps = probeAssetCapabilities(gl as unknown as Parameters<typeof probeAssetCapabilities>[0], gl !== null);
      context.log(`能力：${describeCapabilities(caps)}`);

      // 参考物：一个素色地面，方便看出纹理是否真的贴上去了
      const ground = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.08, 2.4),
        new THREE.MeshStandardMaterial({ color: 0x2b3542, roughness: 0.9 }),
      );
      ground.position.y = -0.04;
      stage.scene.add(ground);

      plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 1.6),
        new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.7 }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(-1.05, 0.01, 0);
      stage.scene.add(plane);

      rebuildHost(context);
      renderChain();

      const overlay = makeOverlay(context.host, '资源加载');
      rowCaps = addRow(overlay, '能力');
      rowChain = addRow(overlay, '候选链');
      rowActual = addRow(overlay, '实际加载');
      rowLive = addRow(overlay, '缓存 live/pending');
      rowFallback = addRow(overlay, '回退次数');
      rowLoadTime = addRow(overlay, '加载耗时');
      rowDecoderCost = addRow(overlay, '解码器体积');
      if (rowCaps !== null) {
        rowCaps.textContent = `${caps.ktx2 ? 'KTX2' : '—'} / ${caps.draco ? 'DRACO' : '—'} / ${caps.webgl2 ? 'WebGL2' : 'WebGL1'}`;
        rowCaps.style.color = caps.ktx2 ? 'var(--good)' : 'var(--bad)';
      }
      if (rowDecoderCost !== null) {
        // 这个数字就是「为什么不进主包」的全部理由
        rowDecoderCost.textContent = 'basis 527KB + draco 285KB（按需拉取）';
      }

      const controls = makeControls(context.host);
      addButton(controls, '加载纹理', () => {
        void (async () => {
          if (host === null) return;
          const started = performance.now();
          try {
            const texture = await host.loadTexture(TEXTURE_BASE, ['png']);
            refs += 1;
            const elapsed = performance.now() - started;
            if (refs === 1) coldMs = elapsed;
            loadTiming.push(elapsed);
            if (plane !== null) {
              const material = plane.material as THREE.MeshStandardMaterial;
              material.map = texture;
              material.color.set(0xffffff);
              material.needsUpdate = true;
            }
            if (rowActual !== null) {
              rowActual.textContent = `${texture.name || 'texture'} · ${texture.image === undefined ? '?' : `${(texture as unknown as { image: { width?: number } }).image?.width ?? '?'}px`}`;
            }
            context.log(`纹理就绪 ${elapsed.toFixed(1)}ms（引用 ${refs}）`);
          } catch (error) {
            context.log(`纹理加载失败：${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      });

      addButton(controls, '加载网格', () => {
        void (async () => {
          if (host === null || stage === null) return;
          const started = performance.now();
          try {
            const object = await host.loadMesh(MESH_URL, MESH_PLAIN);
            const elapsed = performance.now() - started;
            if (loadedMesh !== null) stage.scene.remove(loadedMesh);
            loadedMesh = object;
            object.position.set(1.15, 0.7, 0);
            object.scale.setScalar(0.9);
            stage.scene.add(object);
            context.log(`网格就绪 ${elapsed.toFixed(1)}ms：${countTris(object)} 三角面`);
          } catch (error) {
            context.log(`网格加载失败：${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      });

      addButton(controls, '释放一次', () => {
        if (host === null || refs === 0) {
          context.log('没有可释放的引用');
          return;
        }
        refs -= 1;
        host.textures.release(TEXTURE_BASE);
        context.log(`释放 → 剩 ${refs} 个引用（${refs === 0 ? '进入宽限期，还没真 dispose' : '还在用，不会被回收'}）`);
      });

      addButton(controls, '回收', () => {
        if (host === null) return;
        const freed = host.collect();
        context.log(freed === 0 ? '宽限期未过，回收 0 个' : `回收 ${freed} 个纹理`);
      });

      const lowBtn = addButton(controls, '强制降级', () => {
        forceLow = !forceLow;
        lowBtn.textContent = forceLow ? '恢复真实能力' : '强制降级';
        lowBtn.classList.toggle('on', forceLow);
        rebuildHost(context);
        renderChain();
        if (rowCaps !== null) rowCaps.textContent = forceLow ? '强制：无压缩纹理 / 无 DRACO' : `${caps?.ktx2 ? 'KTX2' : '—'} / ${caps?.draco ? 'DRACO' : '—'}`;
      });
      void lowBtn;

      addButton(controls, '并发 4 次同一张', () => {
        void (async () => {
          if (host === null) return;
          const started = performance.now();
          const results = await Promise.all([
            host.loadTexture(TEXTURE_BASE, ['png']),
            host.loadTexture(TEXTURE_BASE, ['png']),
            host.loadTexture(TEXTURE_BASE, ['png']),
            host.loadTexture(TEXTURE_BASE, ['png']),
          ]);
          refs += 4;
          const same = results.every((item) => item === results[0]);
          context.log(`4 次并发 ${(performance.now() - started).toFixed(1)}ms，返回同一个对象：${same ? '是（合并生效）' : '否'}`);
        })();
      });
    },

    unmount() {
      detachOrbit?.();
      detachOrbit = null;
      host?.dispose();
      host = null;
      stage?.dispose();
      stage = null;
      plane = null;
      loadedMesh = null;
      caps = null;
      refs = 0;
    },

    tick() {
      if (stage === null || host === null) return;
      stage.renderer.render(stage.scene, stage.camera);
      const stats = host.stats;
      if (rowLive !== null) rowLive.textContent = `${stats.textures.live + stats.meshes.live} / ${stats.textures.pending + stats.meshes.pending}`;
      if (rowFallback !== null) {
        rowFallback.textContent = `${stats.fallbacks}（miss ${stats.textures.misses + stats.meshes.misses} / hit ${stats.textures.hits + stats.meshes.hits} / 合并 ${stats.textures.coalesced + stats.meshes.coalesced}）`;
        rowFallback.style.color = forceLow ? 'var(--warn)' : '';
      }
      if (rowLoadTime !== null) {
        rowLoadTime.textContent = coldMs > 0 ? `冷 ${coldMs.toFixed(0)}ms / 热 ${loadTiming.median.toFixed(1)}ms` : '—';
      }
    },

    async bench(): Promise<BenchResult> {
      // 缓存吞吐：同一个 key 反复 acquire/release，命中路径不该有任何 IO。
      // acquire 是异步的，所以按批次计时再摊薄 —— 单次只有微秒级，量不到。
      const cache = new AssetCache<number>({
        loader: () => new Promise<number>((resolve) => resolve(7)),
        dispose: () => undefined,
      });
      await cache.acquire('k');
      const rounds = 20;
      const perRound = 200;
      let totalMs = 0;
      for (let round = 0; round < rounds; round += 1) {
        const started = performance.now();
        for (let i = 0; i < perRound; i += 1) {
          cache.release('k');
          await cache.acquire('k');
        }
        totalMs += performance.now() - started;
      }
      const hitPerCallUs = (totalMs * 1000) / (rounds * perRound);

      // 候选链计算：每次加载前都要算，量级必须可忽略
      const chain = timeBatch((i) => textureCandidates(`u/${i}`, caps ?? conservativeCapabilities('bench'), ['png']), 4000);

      const stats = host?.stats;
      // 真实资产体积：把四个文件的 HTTP 大小算出来，证明「压缩版确实更小」
      const sizes = await Promise.all(
        ['crate.ktx2', 'crate.png', 'crate.glb', 'crate-plain.glb'].map(async (name) => {
          try {
            const response = await fetch(`./test-assets/${name}`);
            const buffer = await response.arrayBuffer();
            return { name, bytes: buffer.byteLength };
          } catch {
            return { name, bytes: -1 };
          }
        }),
      );
      const ktx2 = sizes.find((item) => item.name === 'crate.ktx2')?.bytes ?? -1;
      const png = sizes.find((item) => item.name === 'crate.png')?.bytes ?? -1;

      return {
        lines: [
          { label: '缓存命中', value: `${hitPerCallUs.toFixed(2)}µs`, hint: 'release + acquire 一轮（含一次微任务）' },
          batchLine('候选链计算', chain.perCallUs, '4000 次批量均值'),
          {
            label: '资产体积',
            value: `ktx2 ${ktx2}B vs png ${png}B`,
            hint: png > 0 && ktx2 > 0 ? `${(ktx2 / png).toFixed(2)}× —— 小图看不出优势，大图才拉开` : '取不到资产',
          },
          {
            label: '当前缓存',
            value: stats === undefined ? '—' : `live ${stats.textures.live + stats.meshes.live} / 回退 ${stats.fallbacks}`,
            hint: '回退数 > 0 说明这张设备走了降级路径',
          },
        ],
      };
    },
  };
}

function countTris(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geometry === undefined) return;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (index !== null) total += index.count / 3;
    else if (position !== undefined) total += position.count / 3;
  });
  return Math.round(total);
}
