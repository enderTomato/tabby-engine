# ADR-004 · 视图抽象

- **状态**：Accepted
- **日期**：2026-11-14
- **影响范围**：`packages/engine`、`packages/render2d`、`packages/render3d`、`packages/animation`；任务 T02 T04

## 背景

引擎主循环需要驱动渲染，但引擎不应该知道有个叫 Three.js 的库。理由不是洁癖：

1. 半开源要求物理与核心能单独发布，如果 core 依赖 Three，谁想用就得多装 600KB
2. Android 上渲染器可能整个挂掉，引擎逻辑（模拟、存档、AI）必须继续跑
3. 未来可能需要无渲染的服务端模拟（存档校验、多人大厅），那时不该有渲染依赖

## 可选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 引擎直接持有 `THREE.WebGLRenderer` 和 `PIXI.Application` | 直接、少一层 | core 被渲染库污染；无法无渲染运行；换渲染器重写 |
| B. 引擎定义 `RenderBackend` 抽象基类，渲染器继承 | 有契约 | 继承关系强制渲染器知道引擎内部类型，容易反向耦合 |
| C. **引擎定义最小接口 `ViewAdapter`，渲染器实现它** | 结构体式解耦；引擎只调生命周期 | 接口变更会波及全部实现 |
| D. 事件总线解耦（引擎发事件，渲染器自己订阅） | 完全解耦 | 帧顺序不可控；渲染器不知道何时该画 |

## 决策

**选 C。`ViewAdapter` 只有 6 个方法 + 2 个可选钩子：**

```ts
interface ViewAdapter {
  readonly id: string;
  readonly order?: number;        // 渲染顺序，越小越先
  attach(ctx: ViewContext): Promise<void> | void;
  resize(width: number, height: number, dpr: number): void;
  render(frame: ViewFrame): void;
  applyProfile?(profile: QualityProfile): void;  // 降档时调整分辨率/MSAA
  setActive?(active: boolean): void;             // 多视图切换
  dispose(): void;
}
```

引擎只做三件事：按 `order` 排序后依次 `attach` → 每帧 `render` → 卸载时 `dispose`。

**关键设计：单个视图 `attach` 失败不拖垮引擎。** 每个视图独立 try/catch，失败记入 `failedViewIds` 并广播 `view-error`，其余视图继续。这是 Android 老驱动上最实用的韧性策略——3D context 创建失败时，2D 面板还能显示"当前设备不支持 3D"。

## 后果

### 正面

- `@tabby/render3d` 整个不装，引擎依然能跑逻辑（无头模拟、测试、服务端）
- 渲染器升级不影响引擎，反之亦然
- 可以插一个"空视图"做性能基线测试，量化渲染开销
- 视图可插拔：加一个 WebGPU 视图不需要改引擎一行

### 负面

- 引擎无法为渲染做优化决策。比如"这个物体被遮挡了不用画"这种判断，引擎做不了，只能交给视图内部
- `ViewFrame` 里只能放通用数据（帧号、alpha、deltaMs、profile），Three 特有的东西传不进去
- 多一层间接调用，但每帧只有 2-3 次，开销可忽略

## 风险与缓解

| 风险 | 触发条件 | 缓解措施 |
|---|---|---|
| 接口膨胀 | 陆续有人要求"给我传个场景引用" | 接口变更需走 ADR；只加可选方法，不改签名 |
| 视图内部藏逻辑 | 渲染器里偷偷算物理 | 评审红线：视图不得持有物理状态，只读 TypedArray |
| 降档下发不及时 | `applyProfile` 可选，实现方漏写 | 可选钩子，但 demo 两个视图都实现了 |
| 渲染顺序混乱 | 多视图 `order` 冲突 | `order` 相同按注册顺序，稳定排序 |

## 相关

- 代码：`packages/engine/src/view.ts`、`packages/engine/src/engine.ts`
- 实现：`packages/render2d/src/view2d.ts`、`packages/render3d/src/view3d.ts`
- 任务：T02 T04
