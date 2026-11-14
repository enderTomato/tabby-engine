# 扩展 Tabby 物理引擎

物理包是「半开源」的：核心稳定，边界明确，扩展点齐全。这份文档说明边界在哪、怎么扩展、以及什么算破坏性变更。

## 1. 三个入口

```ts
import { PhysicsWorld, Ragdoll, WindField } from '@tabby/physics';            // Public
import { PhysicsEventBus, type PhysicsPlugin } from '@tabby/physics/extension'; // Extension
import { createWindForce, createLeashConstraint } from '@tabby/physics/presets'; // 现成的扩展实现
```

| 入口 | 包含什么 | 稳定性 |
|---|---|---|
| `@tabby/physics` | `PhysicsWorld`、`Ragdoll`、`FluidSolver`、`SmokeSystem`、`WindField`、`ObstacleGrid`、全部配置类型 | **semver 保护**。删符号、改签名、加必填字段都算破坏性变更 |
| `@tabby/physics/extension` | `PhysicsPlugin`、`ForceField`、`CustomConstraint`、`PhysicsEventBus`、两个注册表 | 次版本可以**加**成员，不改已有成员 |
| `@tabby/physics/presets` | `createWindForce`、`createExplosionForce`、`createLeashConstraint` | 同上，属于示例性质，可被复制进业务代码 |

内部实现用 `@internal` 标注，`tsconfig` 里的 `stripInternal: true` 会把它们从 `.d.ts` 里剔除。比如 `PhysicsWorld.getGridStats()` 只给诊断面板用，编译后在下游的 `.d.ts` 里根本看不到。

## 2. 物理世界的步进顺序

```
plugin.onBeforeStep(world, dt)
      ↓
forces.apply(ctx, dt)          // 风、爆炸、自定义力场
      ↓
积分 + 距离约束 + 弯曲限制 + 碰撞（每帧 4 次迭代）
      ↓
constraints.solve(ctx)         // 自定义约束
      ↓
plugin.onAfterStep(world, dt)
```

这个顺序是契约：

- **外力必须在积分前**。放到积分后，这一帧的力要等下一帧才生效，视觉上慢一拍。
- **自定义约束必须在内置约束后**。放前面会被内置求解器覆盖——位置又被推回去了。

## 3. 扩展一个自定义约束

需求：限制某个布娃娃的第 0 个点离锚点不超过 0.5 米（牵引绳）。

```ts
import type { CustomConstraint, ConstraintContext } from '@tabby/physics/extension';

const leash: CustomConstraint = {
  id: 'leash-dog',
  solve(ctx: ConstraintContext): void {
    for (const ragdoll of ctx.ragdolls) {
      if (ragdoll.id !== 'dog') continue;
      const i = 0;
      const dx = ragdoll.positions[i * 3] - 0;
      const dy = ragdoll.positions[i * 3 + 1] - 6;
      const dz = ragdoll.positions[i * 3 + 2] - 0;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= 0.5) continue;
      const k = 0.5 / dist;
      ragdoll.positions[i * 3] = dx * k;
      ragdoll.positions[i * 3 + 1] = 6 + dy * k;
      ragdoll.positions[i * 3 + 2] = dz * k;
    }
  },
};

world.addConstraint(leash);
```

三条写法上的规矩：

1. **只改 `positions`，不改 `prev`**。改 `prev` 等于凭空注入速度，下一帧布娃娃会被弹开。速度应该由下一次 Verlet 积分自然产生。
2. **按 `invMass` 分配修正量**。固定点（`invMass === 0`）不能被推动，否则会把整个骨架拽走。
3. **不要写 `positions` 之外的东西**，尤其别碰 `bones` 与 `pinned`。

## 4. 写一个插件

插件适合「一整块可插拔行为」，比如「地面结冰时所有布娃娃摩擦下降」。

```ts
import type { PhysicsPlugin, PluginWorldView } from '@tabby/physics/extension';

const icePlugin: PhysicsPlugin = {
  name: 'ice-floor',
  register(world: PluginWorldView): void {
    // 注册期：拿到的 world 是只读视图，只能注册子对象
    world.events.on('collision', (e) => {
      if (e.obstacleId === 'ice') console.log('踩到冰了', e.ragdollId);
    });
  },
  onBeforeStep(world: PluginWorldView, dt: number): void {
    // 每步一次，可以在这里推风速、改力场强度
  },
  onAfterStep(): void {
    // 步完之后，适合做统计与上报
  },
  dispose(): void {
    // 释放事件订阅。不释放会随世界一直存活（订阅是强引用）
  },
};

world.use(icePlugin);
```

**插件异常被隔离**：任何钩子抛异常都会变成一条 `pluginError` 事件，插件自身被跳过，物理世界继续跑。移动端没有崩溃上报面板，宁可吞掉一次插件错误，也不能让整个游戏黑屏。

插件重名会抛错（`use` 的返回值是 `this`，链式调用）。先 `remove` 再 `use`。

## 5. 事件与频率控制

| 事件 | 触发时机 | 频率 |
|---|---|---|
| `bodySleep` | 布娃娃从运动变为静止 | 每次入睡一次 |
| `bodyWake` | 被外力或障碍变化唤醒 | 每次唤醒一次 |
| `collision` | 某点**开始**接触地面/障碍 | 边沿触发，稳态不重复 |
| `liquidOverflow` | 液体格子溢出 | 采样 |
| `step` | 每个物理步 | 每步一次 |
| `pluginError` | 插件钩子抛异常 | 出错时 |
| `eventsDropped` | 本步有事件因采样预算被丢弃 | 有丢弃时 |

`collision` 是边沿触发的：布娃娃躺在地上，9 个点每帧都在接触，如果按「接触」发事件就是 540 次/秒。只在 0→1 时发，稳态下每秒个位数。

需要更高频的数据时用 `emitSampled`，它按「每步预算」节流：

```ts
bus.emitSampled('collision', event, 8); // 一步最多 8 条
```

被丢弃的数量会在步末通过 `eventsDropped` 汇总，**不会静默吞掉** —— 如果看到这个事件量大，说明该降采样或者改事件粒度了。

## 6. 版本与弃用

- 遵循 semver。`0.x` 阶段次版本可能不兼容，但会在 CHANGELOG 里逐条列出。
- 弃用流程：先加 `@deprecated` 注释 + 保留实现（至少一个次版本），再在下一个大版本删除。JSDoc 的 `@deprecated` 在 VS Code 里会直接划掉，使用者能看到。
- 公开面有一份快照 `packages/physics/etc/api-surface.md`（三个入口的 `.d.ts` 去注释后做哈希）。任何改动都会让 `pnpm api-report` 与测试用例失败，必须显式 `--update` 并提交快照。改之前先想清楚是不是真的要改。

```bash
pnpm --filter @tabby/physics api-report            # 比对公开面，不一致退出 1
pnpm --filter @tabby/physics api-report -- --update # 确认改动后更新基线
pnpm --filter @tabby/physics docs                  # 生成 TypeDoc 到 packages/physics/docs/api
```

> 为什么不用 api-extractor：它捆绑自己的 TypeScript（7.60 是 6.0.3），与项目用的 5.9 不兼容，
> 跟随 `extension.ts` 的类型 re-export 时会内部报错（`Unable to follow symbol`）。
> 等它跟上再换回来。快照方案更严格（加字段也会触发），只是没有语义化的 diff。

## 7. 不该做的事

| 做法 | 为什么不行 |
|---|---|
| 在物理包里 `import three` | 物理跑在 Worker 里，Worker 没有 DOM 与 WebGL 上下文。这条是硬红线（ADR-002） |
| 直接写 `ragdoll.positions` 做「效果」 | 位置由约束求解器独占维护，外部写会破坏「位置 = 约束结果」的不变量，表现为拉长或炸开。要施力用 `addAcceleration`，要冲击用 `addRadialImpulse` |
| 遍历 `world.getRagdolls()`（Map）做结算 | Map 是插入序，删了再插顺序就变。确定性红线（ADR-001），要用 `getRagdollOrder()` |
| 每帧 `new Float32Array` | 物理每帧跑，任何每帧分配都会让 GC 抖动。所有临时缓冲都是类字段复用 |
