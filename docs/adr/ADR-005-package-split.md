# ADR-005 · 包拆分粒度

- **状态**：Accepted
- **日期**：2026-11-14
- **影响范围**：全仓库；任务 T02

## 背景

原计划（P02）要求 11 个包：`core` `physics` `render-3d` `render-2d` `input` `ui` `gameplay` `terrain` `economy` `graph` `platform`，加 `apps/demo` 与 `apps/playground`。

实际落地时发现两个问题：

1. **周期依赖风险**：`render-3d` 需要读物理状态（粒子位置、布娃娃骨骼），如果物理状态只能通过 `core` 传递，`core` 就会被迫认识物理数据结构
2. **Worker 无处安放**：流体放在 Worker 里跑，但 Worker 代码同时依赖 `physics`（求解器）和 `platform`（能力探测），原计划里没有合适的包承载

## 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 严格照搬 11 包 | 与计划一致 | Worker 宿主代码只能塞进 engine，engine 变胖且带 Worker 依赖 |
| B. 合并成 3 个大包（core/render/app） | 包少，循环依赖风险低 | 物理无法独立发布，"半开源"卖点落空 |
| C. **在 11 包基础上增补 4 个包** | 依赖方向可被依赖图强制；物理可独立发 npm | 包数量变多，构建时间略增 |

## 决策

**选 C。实际 8 个包（已完成部分）+ 计划 7 个包（待建）：**

### 已建

| 包 | 职责 | 关键约束 |
|---|---|---|
| `@tabby/core` | 事件总线、定步循环、性能采样、确定性 RNG | 零渲染依赖，零 DOM 依赖 |
| `@tabby/platform` | 能力探测、档位判定、GPU 黑名单、诊断 | **唯一允许直接访问浏览器 API 的包** |
| `@tabby/physics` | 四套物理效果 | **不 import three/pixi**，只依赖 core |
| `@tabby/worker` | FluidHost 三档降级、SAB 协议 | 依赖 physics + platform |
| `@tabby/render2d` | Pixi 视图 | 依赖 physics（只读 TypedArray） |
| `@tabby/render3d` | Three 视图 | 同上 |
| `@tabby/animation` | GSAP 接入，由主循环驱动 | 依赖 core |
| `@tabby/engine` | 视图调度、自适应降级 | 依赖 core + platform + physics + worker |

### 待建

`terrain` `economy` `graph` `input` `ui` `gameplay` + `apps/playground`

## 依赖方向（硬约束）

```
                    apps/demo · apps/playground
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        render2d         render3d        animation
              │               │               │
              └───────┬───────┘               │
                      ▼                       │
                   engine ◄───────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     worker       physics        platform
        │             │             │
        └──────┬──────┘             │
               ▼                    │
             core ◄─────────────────┘
```

**规则：箭头只能向下。** 同层之间除 `worker → physics` 外不得横向依赖。

## 关键决策：为什么物理能被渲染层直接依赖

`render2d` / `render3d` 的 `dependencies` 里确实有 `@tabby/physics`。这**不违反**"物理不依赖渲染"，因为方向是渲染 → 物理，不是物理 → 渲染。

反过来的约束靠依赖图强制：`packages/physics/package.json` 的 `dependencies` 只有 `@tabby/core`，谁 import 了 three 就装不上。

## 后果

### 正面

- 物理包可独立 `npm publish`，不需要带渲染库
- Worker 代码有归属，`engine` 不被迫依赖 Worker 实现（通过 `workerFactory` 注入）
- 依赖违规能在 `pnpm install` 阶段暴露，而不是靠人盯

### 负面

- 8 个包意味着 8 次 tsc 编译，全量构建约 8 秒
- 跨包改动要重新 build 依赖方，开发时需要 `build:pkgs` 先行
- 包数量多，新人理解成本上升，靠 ADR + README 补

## 风险与缓解

| 风险 | 触发条件 | 缓解措施 |
|---|---|---|
| 循环依赖 | 有人为图方便让 physics import engine | CI 加 `madge --circular` 检查 |
| 包粒度继续膨胀 | 遇到问题就新建包 | 新建包必须写 ADR，说明为什么不能放进现有包 |
| 构建慢 | 包继续增加 | 已上 `composite: true` 增量编译；必要时上 turbo |

## 相关

- 根配置：`pnpm-workspace.yaml`、`tsconfig.base.json`
- 任务：T02
