# @tabby/physics

Tabby 引擎的自研物理包：SPH-lite 流体、Verlet 布娃娃/绳索、解析摆与双摆、烟雾粒子、风场、空间哈希宽相位。

**零渲染依赖** —— 不 import three / pixi，不认识 Canvas，可以直接跑在 Worker 里。这是硬约束（ADR-002），不是「暂时没用到」。

## 安装

```bash
pnpm add @tabby/physics
```

## 快速开始

```ts
import { PhysicsWorld } from '@tabby/physics';

const world = new PhysicsWorld({
  gravity: 9.8,
  bounds: { min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 14, z: 12 } },
  ragdoll: { iterations: 4, bendLimit: 0.55 },
});

// 静态障碍：建筑、挡板
world.addObstacle({
  id: 'house-1',
  min: { x: 0, y: 0, z: 0 },
  max: { x: 2, y: 3, z: 2 },
  kind: 'solid',
});

// 布娃娃
const ragdoll = world.spawnHumanoid('npc-1', 5, 4, 0, 1);

// 每步一次
world.step(1 / 60);

// 渲染层只读 positions / renderData，不反向写
console.log(ragdoll.positions[1]);
```

## 提供什么

| 模块 | 能力 | 说明 |
|---|---|---|
| `FluidSolver` | SPH-lite / PBF | 双缓冲 SoA，1500 粒子约 1.2ms，可整体挪进 Worker |
| `Ragdoll` | Verlet + 距离约束 + 弯曲软限制 | 9 点人形，支持休眠、渲染插值、绳索 Catmull-Rom 平滑 |
| `Pendulum` | 解析单摆 | 任意帧率不漂移，成本几次三角函数 |
| `DoublePendulum` | 双摆 RK4 | 解真正的耦合方程，才有混沌翻滚的观感 |
| `SmokeSystem` | 粒子 + 风场拖曳 | 无风场时退回正弦扰动 |
| `WindField` | value noise + 间歇阵风 | 摆动与烟雾共享同一实例，风向才对得上 |
| `ObstacleGrid` | 均匀网格宽相位 | 每点碰撞从 O(盒数) 降到 O(1)，溢出自动降级 |

## 关键设计

**零每帧分配。** 物理每帧都跑，任何临时 `new Float32Array` 都会让 GC 抖动。所有缓冲都是类字段复用。

**确定性。** 步进顺序用显式数组而不是 `Map` 遍历序；随机用可种子化 PRNG；风场噪声用 `Math.imul` 整数哈希（跨平台逐位一致）。存档回放依赖这些。

**休眠。** 静止 0.5 秒后整具跳过积分。城市里躺着几十具布娃娃是常态，不休眠就是白烧 CPU。场景变化会 `wake()`。

**渲染插值。** 物理 30Hz + 屏幕 60Hz 时，用 `writeInterpolatedSegments(out, alpha)` 把两帧之间的状态平滑出来，代价是显示滞后不到一帧。

## 扩展

```ts
import { createWindForce, createLeashConstraint } from '@tabby/physics/presets';

world.addForceField(createWindForce('wind', world.wind, { strength: 2 }));
world.addConstraint(createLeashConstraint('leash', 'npc-1', 0, { x: 0, y: 6, z: 0 }, 0.5));
```

插件、事件、注册表的完整说明见 [docs/EXTENDING.md](../../docs/EXTENDING.md)。

## API 分层

```
@tabby/physics            公开面，semver 保护
@tabby/physics/extension  插件接口、事件总线、注册表
@tabby/physics/presets    现成的扩展实现（可作为自定义约束的范例）
```

内部符号标 `@internal`，编译后从 `.d.ts` 剔除。公开面的任何变化都会让 `pnpm api-report` 报错，需要显式确认。

## 性能（SwiftShader 软渲染，低端档参数）

| 场景 | 每步耗时 |
|---|---|
| 9 个布娃娃 + 9 障碍 + 180 流体粒子 + 120 烟雾 | 0.3~0.6 ms |
| 1 个布娃娃落地 → 休眠 | 入睡后 0 ms |

预算线是主线程 8ms/帧。

## 许可

MPL-2.0。修改本包内的文件需要以 MPL 公开改动，但链接进闭源商业项目不受限制。详见仓库根目录 `LICENSING.md`。
