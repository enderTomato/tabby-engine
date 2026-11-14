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
│ @tabby/terrain   高程导入 / 分块 / LOD / 法线      │
│ @tabby/economy   tick 分层 / 供需价格 / 二进制存档  │
│ @tabby/graph     物流图 / CSR / 最短路缓存         │
│ @tabby/input     手势识别 / 44px 热区 / 相机惯性    │
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
| 经济层不碰渲染与时钟 | `@tabby/economy` 的 `lib` 只有 `ES2022`，写 `window` / `performance` 直接编译失败；时间从 `advance(dt)` 注入 |

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

## Playground

`apps/playground` 是**逐特性隔离验证台**，不是第二个 demo：12 个探针各自只加载该特性的
最小依赖、各自跑分，一个崩了不拖垮别的。外壳用纯 DOM 而不是 Vue —— 这是「引擎不绑框架」
的唯一证据。

```bash
pnpm dev:playground                      # http://localhost:5174
node tools/smoke-playground.mjs 4175     # 无头跑一遍
```

设计与「怎么加一个探针」见 [docs/PLAYGROUND.md](docs/PLAYGROUND.md)。

## 模块完成度

21 项任务的当前状态。**「有骨架」和「能用」是两件事**，这里只标能用。

| 模块 | 状态 | 关键能力 |
| --- | --- | --- |
| 平台能力探测 | ✅ | 能力位、三档 profile、GPU 黑名单（软渲染强制低端） |
| 物理：布娃娃 | ✅ | 空间哈希宽相位、休眠唤醒、渲染插值、弯曲限制、CCD 近似 |
| 物理：液体 | ✅ | 交错网格通量、CFL 子步、水量守恒、Uint16 存档 |
| 物理：风场/烟雾 | ✅ | `Math.imul` 精确哈希 value noise、阵风奇次幂塑形、拖曳耦合 |
| 物理：摆动/双摆 | ✅ | 单摆解析解 + 双摆 RK4 |
| 物理扩展 API | ✅ | 三层入口（Public/Extension/Internal）、事件总线、插件宿主、API 快照 |
| 地形 | ✅ | 分块网格 + skirt、屏幕误差 LOD、编辑 diff、GeoTIFF 导入 |
| 经济内核 | ✅ | 8 步固定顺序、TypedArray 实体池、供需价格、二进制存档 |
| 物流图 | ✅ | CSR、惰性删除 Dijkstra、脏子图分帧重算、效率适配器 |
| 输入层 | ✅ | 8 种手势、44px 热区、触感探测、帧率无关惯性 |
| 渲染桥 | ✅ | 投影、视锥剔除、射线遮挡、去重叠（确定性排序） |
| 小地图 | ✅ | 1 格 1 像素离屏缩略图，脏才重绘 |
| 分块存档 | ✅ | TBCK 格式、随机访问单块、FNV-1a 校验、流式加载 |
| 配置表热重载 | ✅ | 双层校验 + JSON 路径错误、失败保留旧表、无变化不重建 |
| 调参面板 | ✅ | 6 个旋钮全部真写世界，写失败弹回真实值 |
| 联动契约 | ✅ | `docs/CONTRACTS.md`：依赖矩阵 + 暴雨端到端时序 |
| 上线清单 | ✅ | `docs/RELEASE-CHECKLIST.md`：9 组检查项，含"怎么验" |
| UI 包 / 玩法包 | ✅ | `@tabby/ui`（零依赖 Vue）+ `@tabby/gameplay`（参考玩法）；demo 只剩模板与组装 |
| 资源加载器 | ✅ | `@tabby/assets`：能力探测 → 候选链 → 加载；解码器按需拉取，不进主包 |
| 3D 优化 | ✅ | DRS、阴影预算、建筑 LOD、上下文丢失恢复、KTX2 接入（明确不做 CSM，见 ADR-008） |
| 独立 playground | ✅ | `apps/playground`：12 个探针逐特性隔离 + 批量计时跑分 + 无头冒烟 |

测试：**345 项**（physics 44 / economy 31 / graph 26 / terrain 23 / input 30 / render3d 43 /
assets 33 / ui 39 / gameplay 13 / demo 63），全仓库 `pnpm typecheck` 零错误。
另有两条无头冒烟：`node tools/smoke-demo.mjs`（含真实上下文丢失恢复）、
`node tools/smoke-playground.mjs`（12 个探针逐个挂载 + 跑分）。

## 架构决策

不可逆决策记录在 [docs/adr/](docs/adr/README.md)，共 8 条：渲染混合、物理积分、线程模型、
视图抽象、包拆分、液体路线、经济权威、3D 优化路线（含「为什么不做 CSM」）。

写 ADR 的判定标准、模板与索引见该目录 README。

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 依赖矩阵、每帧时序、「暴雨」端到端链路 |
| [docs/QUALITY.md](docs/QUALITY.md) | DRS / 阴影预算 / 建筑 LOD / 上下文丢失的参数与排障 |
| [docs/ASSETS.md](docs/ASSETS.md) | KTX2 / DRACO：能力探测、候选链、解码器托管、缓存 |
| [docs/PLAYGROUND.md](docs/PLAYGROUND.md) | 12 个探针、跑分口径、怎么加探针 |
| [docs/LOGISTICS.md](docs/LOGISTICS.md) | 路网建模与效率曲线 |
| [docs/EXTENDING.md](docs/EXTENDING.md) | 插件与扩展点 |
| [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) | 上线前逐项检查（含「怎么验」） |
| [docs/ANDROID-DEPLOY.md](docs/ANDROID-DEPLOY.md) | 四套部署配置 |

## 部署

COOP/COEP 是 SharedArrayBuffer 的硬前提，详见 [docs/ANDROID-DEPLOY.md](docs/ANDROID-DEPLOY.md)，含 Nginx / Vercel / Capacitor / WebView 四套配置。

```nginx
add_header Cross-Origin-Opener-Policy   "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

## 许可

MIT
