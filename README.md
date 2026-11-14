# Tabby Engine

面向 **Android 优先** 的 Web 游戏引擎骨架。渲染底座 WebGL2，2D/UI 走 Pixi.js，3D 走 Three.js，物理是自研轻量库（流体 / 布娃娃 / 摆动 / 烟雾），状态层用 Vue3 + GSAP。

设计目标不是"又一个 Three 封装"，而是把 **移动端碎片化** 当成一等公民：能力探测、质量分档、自动降级、Worker 卸载，全部内建。

```
┌───────────────────────────────────────────────┐
│ apps/demo        迷你模拟经营(2D) + 物理试验场(3D) │
├───────────────────────────────────────────────┤
│ @tabby/engine    主循环 / 视图调度 / 自适应降级    │
│ @tabby/animation GSAP 接入（由引擎时钟驱动）       │
├──────────────┬──────────────┬─────────────────┤
│ @tabby/render2d│ @tabby/render3d│ @tabby/worker │
│ Pixi.js       │ Three.js      │ SAB + postMessage│
├──────────────┴──────────────┴─────────────────┤
│ @tabby/physics   零渲染依赖，可单独发 npm         │
├───────────────────────────────────────────────┤
│ @tabby/platform  能力探测 / 档位判定 / GPU 黑名单  │
│ @tabby/core      事件总线 / 定步循环 / 性能采样    │
└───────────────────────────────────────────────┘
```

## 快速开始

```bash
pnpm install
pnpm build        # 编译全部包 + 构建 demo
pnpm dev          # 编译包后启动 demo 开发服务器
pnpm preview      # 预览已构建产物（自带 COOP/COEP 头）

# 只想要能跑的产物（dist 里自带零依赖静态服务器）
cd apps/demo/dist && node serve.mjs
```

> 必须通过 HTTP 访问。`file://` 下拿不到 WebGL2 上下文，Worker 也不行。
>
> 不想装 pnpm 也可以：Release 里的 `-dist` 包解压后 `node serve.mjs` 直接就能跑。

## 分层约束

| 约束 | 实现方式 |
| --- | --- |
| 物理层不碰渲染 | `@tabby/physics` 的 `dependencies` 里没有 three / pixi，靠依赖图强制而非口头约定 |
| 引擎不认识具体渲染器 | `ViewAdapter` 是唯一入口，`render3d` 整个不装也能跑无头模拟 |
| 禁止 `isAndroid` 分支 | 全部走 `PlatformCapabilities` 的能力位判定 |
| 严格模式无 `any` | `strict` + `noUncheckedIndexedAccess`，索引访问强制判空 |

## 平台能力探测

`detectCapabilities()` 产出 `PlatformCapabilities`，关键位：

```ts
caps.webgl2            // WebGL2 是否可用（WebGL1 仅兜底，不为它做功能妥协）
caps.moduleWorker      // 能否用 module 类型 Worker
caps.sharedArrayBuffer // SAB 可用（COOP/COEP 生效）→ 流体走零拷贝
caps.crossOriginIsolated
caps.gpu.vendor        // 'mali' | 'adreno' | 'powervr' | 'apple' | 'unknown'
caps.gpu.flags         // particleScale / disableMsaa / maxTextureSizeCap / forceLocalPhysics
caps.saveData          // 省流量模式 → 自动降档
```

GPU 黑名单在 `packages/platform/src/gpu-blacklist.ts`：按 **厂商 + 渲染器正则** 匹配已知驱动问题，命中后只降不炸（例如 Mali-4xx 关 MSAA、PowerVR 老驱动砍粒子数、部分 Adreno 强制主线程物理）。

## 质量分档

| 档位 | 目标帧率 | CPU 预算 | DrawCall | 流体粒子 | 烟雾 | 布娃娃 | 像素比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 低端（≤2GB / 入门 SoC） | 30 | ≤12ms | 80 | 600 | 120 | 2 | 1.5 |
| 中端 | 60 | ≤8ms | 150 | 1500 | 300 | 4 | 2 |
| 旗舰 | 60 | ≤8ms | 150 | 3000 | 600 | 6 | 2 |

档位由 `resolveTier()` 综合内存、核心数、GPU 厂商、UA 判定，之后 `AdaptiveGovernor` 在运行期持续采样：连续超预算就降档，稳定 5 秒再试探回收。降档会通过 `degrade` 事件广播，视图据此改分辨率与 MSAA。

## 使用

```ts
import { Engine } from '@tabby/engine';
import { Renderer2DView } from '@tabby/render2d';
import { Renderer3DView } from '@tabby/render3d';

const engine = new Engine({
  views: [new Renderer2DView(canvas2d), new Renderer3DView(canvas3d)],
  workerFactory: () => new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' }),
  seed: 20260828,
});

engine.bus.on('ready', ({ tier, profile, mode }) => console.log(tier, profile, mode));
engine.bus.on('degrade', ({ reason }) => console.warn('降级:', reason));
engine.bus.on('view-error', ({ viewId }) => console.warn('视图挂了:', viewId));

await engine.start();
engine.setActiveView('render3d');
```

物理侧直接操作世界，不碰渲染对象：

```ts
import { PhysicsWorld, Ragdoll, Pendulum } from '@tabby/physics';

const world = engine.world;
world.addRagdoll(Ragdoll.humanoid('dummy', 0, 6, 0, 1, { groundY: 0, damping: 0.985, iterations: 4 }));
world.addPendulum(new Pendulum('mill', 8, 6, 0, 3, { gravity: world.gravity }));

engine.bus.on('fixed', ({ dt }) => {
  world.fluid.spawn(40, 0, 8, 0, 1, 1, 1);   // 每逻辑步注入水
});
```

引擎只暴露 `fluidPositions: Float32Array | null`，渲染层直接读同一块内存，无中间拷贝。

## 流体三档降级

`createFluidHost()` 按能力依次尝试：

1. `worker-shared` — Worker + SharedArrayBuffer，主线程零拷贝零等待
2. `worker-copy` — Worker + postMessage 双缓冲
3. `local` — 主线程内联，最后兜底

上层 API 完全一致，模式只体现在 `engine.host.mode`。

## Demo

`apps/demo` 是一个可玩的最小验证场：

- **2D**：网格城市，点击放置住宅/工厂/农场/公园，建筑产出与水循环
- **3D**：俯视试验场，点击上方投放水粒子、观察布娃娃落地、风车摆锤、烟雾升腾
- **右上角面板**：实时 FPS / CPU 耗时 / DrawCall / 粒子数 / 当前档位，附完整诊断报告

控制台可读：`__tabby`（引擎实例）、`__tabby3d.debug()`（绘制规模）。

## 部署

COOP/COEP 是 SharedArrayBuffer 的硬前提，详见 [docs/ANDROID-DEPLOY.md](docs/ANDROID-DEPLOY.md)，含 Nginx / Vercel / Capacitor / WebView 四套配置。

```nginx
add_header Cross-Origin-Opener-Policy   "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

## 许可

MIT
