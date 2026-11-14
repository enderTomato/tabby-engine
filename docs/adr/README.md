# 架构决策记录（ADR）

本目录记录**不可逆或高成本可逆**的架构决策。改动一个小函数不需要 ADR，改一个会约束后续所有模块的边界需要。

## 什么时候必须写

满足以下任意一条：

- 决定了**模块边界**（谁依赖谁、谁不能依赖谁）
- 决定了**数据格式**（存档、序列化、跨进程协议）
- 引入了**第三方运行时依赖**（渲染器、物理库、构建工具）
- 决定了**线程/进程模型**
- 决定了**性能基线**（三档参数、预算分配）
- 事后返工成本 > 2 人日

不需要写：命名、目录内文件拆分、单个算法实现、样式调整。

## 编号规则

`ADR-001` 起，**只增不删**。决策被推翻时，新开一条并把旧的标记为 `Superseded by ADR-xxx`，保留原文——被否决的方案和被废弃的理由同样有价值。

## 模板

```markdown
# ADR-00X · 标题

- **状态**：Accepted / Superseded by ADR-xxx / Deprecated
- **日期**：YYYY-MM-DD
- **决策者**：—
- **影响范围**：涉及哪些包/任务编号

## 背景

为什么现在必须做这个决定？不做的代价是什么？

## 可选方案

| 方案 | 优点 | 缺点 | 移动端成本 |
|---|---|---|---|
| A | | | |
| B | | | |

## 决策

选了什么，一句话说清。

## 后果

### 正面
### 负面（接受的代价）

## 风险与缓解

| 风险 | 触发条件 | 缓解措施 |
|---|---|---|

## 相关

- 代码：`packages/xxx/src/yyy.ts`
- 任务：T0X
```

## 索引

| 编号 | 标题 | 决策一句话 | 日期 | 状态 |
|---|---|---|---|---|
| [ADR-001](ADR-001-render-hybrid.md) | 2D/3D 渲染混合方案 | 双 canvas 独立 WebGL 上下文，不共享 context | 2026-11-14 | Accepted |
| [ADR-002](ADR-002-physics-integration.md) | 物理积分方式 | 布娃娃/摆动用 Verlet，液体用 SPH-lite 粒子，不引入 XPBD | 2026-11-14 | Accepted |
| [ADR-003](ADR-003-thread-model.md) | 线程模型 | Worker + SAB + seqlock 无锁读，三档降级 | 2026-11-14 | Accepted |
| [ADR-004](ADR-004-view-abstraction.md) | 视图抽象 | 引擎不感知 Three/Pixi，仅通过 ViewAdapter 调度 | 2026-11-14 | Accepted |
| [ADR-005](ADR-005-package-split.md) | 包拆分粒度 | 在 11 包计划上拆出 worker/render2d/render3d/animation | 2026-11-14 | Accepted |
| [ADR-006](ADR-006-liquid-route.md) | 液体实现路线 | 先做表现层粒子，地形落地后重构为双层 | 2026-11-14 | Accepted |
