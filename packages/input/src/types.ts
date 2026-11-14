/**
 * 输入层的公共类型与常量。
 *
 * 设计前提：**核心手势识别不认识 DOM**。
 *
 * 手势逻辑（双击间隔、长按阈值、捏合判据）如果直接读 `TouchEvent`，就只有开浏览器能测。
 * 这里把它们收敛成一条 `InputSample` 流水，识别器只吃样本、只吐事件 ——
 * 于是 26 个手势用例可以跑在纯 Node 里（`node --test`），不需要 jsdom / puppeteer。
 *
 * DOM 只在 `PointerSource`（`input.ts`）这一层出现，那层薄到几乎没有逻辑。
 */

/** 归一化后的指针样本。坐标单位是 **CSS 像素**，相对目标元素左上角。 */
export interface InputSample {
  /** 指针 id。多指时用它区分；`pointerId` 在安卓上会被复用，所以释放后不保留。 */
  readonly id: number;
  /** 相对目标元素左上角的 CSS 像素坐标。 */
  readonly x: number;
  readonly y: number;
  /** 时间戳（毫秒）。由外部注入，测试里用假时钟。 */
  readonly t: number;
  /** 指针类型，用于区分「手指」和「鼠标」（热区扩展策略不同）。 */
  readonly pointerType: 'touch' | 'mouse' | 'pen';
  /** 压感 0..1，鼠标恒为 0.5。捏合时可用它做力度区分。 */
  readonly pressure: number;
}

export type SamplePhase = 'down' | 'move' | 'up' | 'cancel';

/** 手势的语义事件。回调参数都带 `source`，方便同屏多个输入源时区分。 */
export interface TapEvent {
  readonly x: number;
  readonly y: number;
  readonly pointerType: InputSample['pointerType'];
  /** 是否命中了某个热区（由 `InputManager` 用 `HitArea` 判定）。 */
  readonly hitId: string | null;
}

export interface DoubleTapEvent extends TapEvent {
  /** 两次点击的间隔（毫秒）。 */
  readonly interval: number;
}

export interface LongPressEvent extends TapEvent {
  readonly duration: number;
}

export interface DragEvent {
  /** 本次拖拽的起点（第一次按下的位置）。 */
  readonly startX: number;
  readonly startY: number;
  /** 当前坐标。 */
  readonly x: number;
  readonly y: number;
  /** 相对上一样本的位移。 */
  readonly dx: number;
  readonly dy: number;
  /** 相对起点的总位移。 */
  readonly totalX: number;
  readonly totalY: number;
  /** 瞬时速度（CSS 像素/毫秒），由最近若干个样本估算。 */
  readonly vx: number;
  readonly vy: number;
}

export interface PinchEvent {
  /** 当前两指间距（CSS 像素）。 */
  readonly distance: number;
  /** 相对上一样本的间距变化。正数表示张开（放大）。 */
  readonly delta: number;
  /** 相对捏合开始时总变化量的比值（1 = 没变）。 */
  readonly scale: number;
  /** 两指中点。 */
  readonly centerX: number;
  readonly centerY: number;
}

export interface RotateEvent {
  /** 两指连线的角度（弧度，屏幕坐标系，顺时针为正）。 */
  readonly angle: number;
  /** 相对上一样本的角度变化（弧度）。 */
  readonly delta: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface TwoFingerPanEvent {
  readonly centerX: number;
  readonly centerY: number;
  readonly dx: number;
  readonly dy: number;
}

export interface WheelEventLike {
  /** 已归一化到「像素」的滚动量。 */
  readonly deltaX: number;
  readonly deltaY: number;
  /** `ctrlKey` 按下表示浏览器把捏合手势报成了滚轮（触控板）。 */
  readonly zoomIntent: boolean;
  readonly x: number;
  readonly y: number;
}

/** 手势识别器的输出。用 discriminant 而不是回调表，方便批量转发与录制回放。 */
export type GestureEvent =
  | { readonly kind: 'down'; readonly sample: InputSample }
  | { readonly kind: 'move'; readonly sample: InputSample }
  | { readonly kind: 'up'; readonly sample: InputSample }
  | { readonly kind: 'cancel'; readonly sample: InputSample }
  | { readonly kind: 'tap'; readonly data: TapEvent }
  | { readonly kind: 'doubletap'; readonly data: DoubleTapEvent }
  | { readonly kind: 'longpress'; readonly data: LongPressEvent }
  | { readonly kind: 'dragstart'; readonly data: DragEvent }
  | { readonly kind: 'drag'; readonly data: DragEvent }
  | { readonly kind: 'dragend'; readonly data: DragEvent }
  | { readonly kind: 'pinchstart'; readonly data: PinchEvent }
  | { readonly kind: 'pinch'; readonly data: PinchEvent }
  | { readonly kind: 'pinchend'; readonly data: PinchEvent }
  | { readonly kind: 'rotate'; readonly data: RotateEvent }
  | { readonly kind: 'pan2'; readonly data: TwoFingerPanEvent }
  | { readonly kind: 'wheel'; readonly data: WheelEventLike };

/**
 * 最小可点尺寸（CSS 像素）。
 *
 * 44 不是随便取的：iOS HIG 是 44pt、Material 是 48dp，取小的那个当下限。
 * 关键点在于**热区要向上取整到逻辑像素**：DPR=2.625 的安卓机上，
 * 44 CSS 像素 = 115.5 设备像素，坐标一取整就丢了半像素，
 * 于是边缘点击会「有时中有时不中」—— 这是最典型的碎片化坑。
 */
export const MIN_TOUCH_TARGET = 44;

/** 长按判定阈值。500ms 是 iOS/Android 系统长按的共同下限。 */
export const LONG_PRESS_MS = 500;

/** 长按期间允许的抖动半径。超过就转为拖拽。 */
export const LONG_PRESS_SLOP = 8;

/** 点击的最大移动距离：超过就认为是拖拽而不是点击。 */
export const TAP_SLOP = 10;

/** 点击的最大时长：超过就可能是长按未触发（手指按久了再抬）。 */
export const TAP_MAX_MS = 600;

/** 双击最大间隔。超过就归为两次单击。 */
export const DOUBLE_TAP_MS = 300;

/** 拖拽判定阈值：超过它才发 dragstart，避免手指微抖就触发拖拽。 */
export const DRAG_START_SLOP = 4;

/** 速度估算窗口（毫秒）。太短会被抖动放大，太长会把急停算成还在动。 */
export const VELOCITY_WINDOW_MS = 80;
