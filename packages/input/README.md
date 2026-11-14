# @tabby/input —— 统一输入层

指针与手势识别、44px 热区、触感反馈能力探测、轨道相机阻尼惯性。
**不依赖 three / pixi / 任何渲染包**，核心逻辑不碰 DOM，可以跑在纯 Node 里。

```bash
pnpm --filter @tabby/input build
node --test packages/input/tests/*.test.mjs   # 30 项
```

## 分层

```
InputManager         DOM 事件 → 归一化样本 → GestureEvent（唯一碰 DOM 的层）
  ├ GestureRecognizer  手势状态机（tap / doubletap / longpress / drag / pinch / rotate / pan2 / wheel）
  ├ hit-area           44px 热区扩展与命中测试
  └ Haptics            vibrate 能力探测 + 节流
OrbitDriver          轨道相机状态 + 帧率无关的惯性（纯数学）
```

## 为什么手势逻辑不碰 DOM

手势的判据全是「时间 + 位移」：双击间隔 300ms、长按 500ms、拖拽阈值 4px。
这些如果在 `TouchEvent` 回调里写，就只能开浏览器测，于是要么没有测试，
要么用 puppeteer 跑几十秒才验证一条。

这里把事件收敛成一条 `InputSample` 流水（`{id, x, y, t, pointerType}`），
时间由外部注入 —— 30 个手势用例用假时钟跑完不到 50ms，且没有 flaky。

## 用法

```ts
import { InputManager, OrbitDriver } from '@tabby/input';

const input = new InputManager(canvas);
input.on((event) => {
  switch (event.kind) {
    case 'tap':
      // event.data.hitId 是命中的热区 id（没设热区时为 null）
      break;
    case 'drag':
      orbit.drag(event.data.dx, event.data.dy);
      break;
    case 'dragend':
      orbit.release(event.data.vx, event.data.vy); // 交给惯性
      break;
    case 'pinch':
      orbit.pinch(event.data.scale, baseDistance);
      break;
  }
});

// 每帧调用一次：驱动长按判定与（延迟模式下的）单击补发
function frame(): void {
  input.update();
  orbit.update(performance.now());
  requestAnimationFrame(frame);
}
```

热区：

```ts
input.setHitAreas([
  { id: 'build', x: 12, y: 12, width: 24, height: 24 },              // 会被扩到 44×44
  { id: 'cell-3-4', x: 0, y: 0, width: 20, height: 20, expandable: false }, // 格子不扩
]);
```

## 手势语义

| 手势 | 触发条件 | 备注 |
|---|---|---|
| `tap` | 位移 ≤ 10px、时长 ≤ 600ms、未长按 | 默认抬手立刻发 |
| `doubletap` | 两次 tap 间隔 ≤ 300ms | 默认模式下会**先收到一次 tap**，可用 `delayTapForDouble` 换 300ms 延迟 |
| `longpress` | 按住 500ms、抖动 ≤ 8px | 由 `update()` 驱动，不用定时器 |
| `dragstart` / `drag` / `dragend` | 位移 ≥ 4px | `dragstart` 只发一次 |
| `pinch` | 双指间距变化 | 与 `rotate`/`pan2` **同时**发，不互斥 |
| `rotate` | 双指连线角度变化 | 角度差折到 (-π, π] |
| `pan2` | 双指中点位移 | |
| `wheel` | 滚轮 | `deltaMode` 已归一化到像素 |

`pinch` / `rotate` / `pan2` 故意不互斥：真实捏合时手指一定带着旋转和位移，
做成「选一个主模式」会让画面在捏合中途突然跳成旋转。

## 44px 热区的两个细节

1. **向上取整到整数像素**。DPR=2.625 的安卓机上 44 CSS 像素 = 115.5 设备像素，
   不取整的话绘制与命中的四舍五入方向可能不同，边缘 1px 会「看得见点不中」。
2. **格子不能扩**。地图格子的边长通常 < 44，扩了会盖住邻居，表现为「点 A 建到 B 上」。
   所以 `HitArea.expandable` 默认 true，`gridHitAreas()` 生成的格子显式设 false。

## 惯性为什么是 `exp(-k·dt)`

线性衰减（`v -= k·dt`）的每一帧衰减量固定，于是 30fps 设备上 8 帧就停、120fps 上 33 帧才停 ——
同一个手感在不同机型上完全不同。指数衰减的**位移用解析积分**：

```
v(t) = v0·e^(-k·t)     →     Δθ = v0·(1 - e^(-k·dt)) / k
```

这样 30fps 与 60fps 在相同时长内转过的角度一致（有测试守着）。

## 触感反馈的三个坑

| 坑 | 处理 |
|---|---|
| iOS Safari 没有 `navigator.vibrate` | 探测后 `isSupported=false`，所有调用返回 false，上层退回纯视觉反馈 |
| 安卓要求用户手势 + sticky activation | 只在手势回调里调用（`InputManager` 已限定），不在初始化时探测 |
| 高频调用被限流 | 60ms 最小间隔，超出的计入 `throttled` 且返回 false |

`report()` 返回 attempts / accepted / throttled / failed，诊断面板可以直接显示。

## Android 碎片化自检清单

| 风险 | 症状 | 这里的处理 |
|---|---|---|
| `touch-action` 未设 | 单指拖动变成页面滚动，拖到一半「松手」 | 构造时写内联 `touch-action: none` |
| `passive: true` 下 preventDefault 静默失效 | 滚轮缩放时页面跟着滚 | 全部监听用 `{passive: false}` |
| `pointercancel`（侧滑返回 / 通知栏下拉）被当成 `up` | 侧滑返回顺手点掉一个按钮 | `cancel` 不发 tap、不发 dragend 之外的任何点击事件 |
| `pointerleave` 无 `pointerup` | 拖出窗口后拖拽状态永久卡住 | `pointerleave` → `cancel` |
| 长按弹出系统菜单 | 安卓选择/保存图片菜单盖住游戏 | `contextmenu` preventDefault |
| `pointerId` 复用 | 幽灵手指，双指状态错乱 | 同 id 再次 `down` 时先把旧的当 cancel 收尾 |
| 帧率差异 | 同一次滑动在不同机型转的角度不同 | 惯性用指数解析积分 |
| `deltaMode` 差异 | Firefox 上一次滚轮顶 Chrome 十几次 | `normalizeWheel` 归一化 |
