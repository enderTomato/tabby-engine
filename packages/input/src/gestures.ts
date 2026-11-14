import {
  DOUBLE_TAP_MS,
  DRAG_START_SLOP,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  TAP_MAX_MS,
  TAP_SLOP,
  VELOCITY_WINDOW_MS,
  type GestureEvent,
  type InputSample,
  type WheelEventLike,
} from './types.js';

export interface GestureOptions {
  readonly longPressMs?: number;
  readonly longPressSlop?: number;
  readonly tapSlop?: number;
  readonly tapMaxMs?: number;
  readonly doubleTapMs?: number;
  readonly dragStartSlop?: number;
  readonly velocityWindowMs?: number;
  /**
   * 是否为了识别双击而**延迟**单击事件。
   *
   * - `false`（默认）：抬手立刻发 tap，若 300ms 内又来一次再补发 doubletap。
   *   代价是「双击一定会先收到一次 tap」，消费方若对 tap 敏感（比如放置建筑），
   *   双击会先放一个再撤销，体验更差。
   * - `true`：等满 300ms 再发 tap，双击干净，但每次点击多 300ms 延迟。
   *
   * 经营类游戏选 `false`（点击要跟手，双击很少用），地图类选 `true`。
   */
  readonly delayTapForDouble?: boolean;
}

interface Track {
  readonly id: number;
  readonly pointerType: InputSample['pointerType'];
  startX: number;
  startY: number;
  x: number;
  y: number;
  downAt: number;
  lastAt: number;
  moved: boolean;
  dragging: boolean;
  longPressed: boolean;
  /** 速度估算样本环，只保留最近 `velocityWindowMs` 内的。 */
  readonly samples: { t: number; x: number; y: number }[];
}

interface PendingTap {
  x: number;
  y: number;
  t: number;
  pointerType: InputSample['pointerType'];
}

type Emitter = (event: GestureEvent) => void;

/**
 * 手势识别器。
 *
 * ## 为什么不直接监听 TouchEvent
 *
 * Pointer Events 已经把「鼠标 / 手指 / 笔」统一了，而且 `setPointerCapture` 能在
 * 手指滑出元素后继续收到事件 —— 这是拖拽必须的（否则拖到屏幕边缘就断）。
 * TouchEvent 要自己维护 touchId ↔ target 映射，代码量翻倍还会漏。
 *
 * 唯一的例外是 `touch-action`：它只能通过 CSS 关闭，Pointer Events 管不了浏览器的
 * 滚动手势。这层在 `input.ts` 里处理。
 *
 * ## 为什么长按靠 `tick()` 而不是 `setTimeout`
 *
 * 后台标签页里 `setTimeout` 会被节流到 1 秒以上，而 `requestAnimationFrame` 会暂停 ——
 * 两种都不理想，但表现可预期的是后者：帧停了游戏也停了，长按不触发是符合直觉的。
 * `setTimeout` 会在切回来的一瞬间补发一堆长按，表现为「刚切回页面就弹出菜单」。
 *
 * 所以长按判定的时钟由外部驱动（`tick(now)`），测试里换成假时钟即可完全复现。
 */
export class GestureRecognizer {
  private readonly emit: Emitter;
  private readonly longPressMs: number;
  private readonly longPressSlop: number;
  private readonly tapSlop: number;
  private readonly tapMaxMs: number;
  private readonly doubleTapMs: number;
  private readonly dragStartSlop: number;
  private readonly velocityWindowMs: number;
  private readonly delayTapForDouble: boolean;

  /** 活动指针，按「按下顺序」排列。**故意用数组而不是 Map**：遍历序要可复现。 */
  private readonly active: Track[] = [];
  private pendingTap: PendingTap | null = null;

  // 双指状态
  private pinchDistance = 0;
  private pinchStartDistance = 0;
  private previousDistance = 0;
  private previousAngle = 0;
  private previousCenterX = 0;
  private previousCenterY = 0;
  private twoFingerActive = false;

  constructor(emit: Emitter, options: GestureOptions = {}) {
    this.emit = emit;
    this.longPressMs = options.longPressMs ?? LONG_PRESS_MS;
    this.longPressSlop = options.longPressSlop ?? LONG_PRESS_SLOP;
    this.tapSlop = options.tapSlop ?? TAP_SLOP;
    this.tapMaxMs = options.tapMaxMs ?? TAP_MAX_MS;
    this.doubleTapMs = options.doubleTapMs ?? DOUBLE_TAP_MS;
    this.dragStartSlop = options.dragStartSlop ?? DRAG_START_SLOP;
    this.velocityWindowMs = options.velocityWindowMs ?? VELOCITY_WINDOW_MS;
    this.delayTapForDouble = options.delayTapForDouble ?? false;
  }

  get activePointers(): number {
    return this.active.length;
  }

  /** 是否正在拖拽（单指）。宿主据此决定要不要在拖动时跳过点击判定。 */
  get isDragging(): boolean {
    return this.active.some((track) => track.dragging);
  }

  down(sample: InputSample): void {
    // 第二指按下：取消长按/点击的候选，转入双指模式。
    // 这里**不**把第一指补发成 tap —— 捏合是独立意图，补发 tap 会误触。
    const existing = this.find(sample.id);
    if (existing !== null) {
      // pointerId 被复用（安卓上偶发）：先把旧的当 cancel 收尾，避免幽灵手指
      this.cancel({ ...sample, id: sample.id });
    }

    const track: Track = {
      id: sample.id,
      pointerType: sample.pointerType,
      startX: sample.x,
      startY: sample.y,
      x: sample.x,
      y: sample.y,
      downAt: sample.t,
      lastAt: sample.t,
      moved: false,
      dragging: false,
      longPressed: false,
      samples: [{ t: sample.t, x: sample.x, y: sample.y }],
    };
    this.active.push(track);
    // 注意不在这里清 pendingTap：单击候选要留到 tick 判超期，
    // 否则「双击的第二下」永远看不到第一下（这是双击识别失败的经典原因）。
    this.emit({ kind: 'down', sample });

    if (this.active.length === 2) this.beginTwoFinger();
  }

  move(sample: InputSample): void {
    const track = this.find(sample.id);
    this.emit({ kind: 'move', sample });
    if (track === null) return;

    const dx = sample.x - track.x;
    const dy = sample.y - track.y;
    track.x = sample.x;
    track.y = sample.y;
    track.lastAt = sample.t;
    track.samples.push({ t: sample.t, x: sample.x, y: sample.y });
    this.trimSamples(track, sample.t);

    const totalX = sample.x - track.startX;
    const totalY = sample.y - track.startY;
    const total = Math.hypot(totalX, totalY);
    if (total > this.tapSlop) track.moved = true;

    if (this.active.length >= 2) {
      this.updateTwoFinger(sample, track);
      return;
    }

    if (track.longPressed) {
      // 长按已触发：后续移动继续按拖拽处理（长按 + 拖动是常见组合）
      if (!track.dragging && total > this.longPressSlop) track.dragging = true;
    }

    if (!track.dragging && total >= this.dragStartSlop) {
      track.dragging = true;
      this.emit({ kind: 'dragstart', data: this.dragData(track, dx, dy) });
    }
    if (track.dragging) this.emit({ kind: 'drag', data: this.dragData(track, dx, dy) });
  }

  up(sample: InputSample): void {
    const index = this.active.findIndex((track) => track.id === sample.id);
    const track = index >= 0 ? (this.active[index] as Track) : null;
    this.emit({ kind: 'up', sample });
    if (track === null) return;

    track.x = sample.x;
    track.y = sample.y;
    track.lastAt = sample.t;
    track.samples.push({ t: sample.t, x: sample.x, y: sample.y });
    this.trimSamples(track, sample.t);

    // 先算出数据，再从数组里摘掉 —— 摘掉之后就拿不到起点了
    const wasDragging = track.dragging;
    const dragData = this.dragData(track, sample.x - track.x, sample.y - track.y);
    const duration = sample.t - track.downAt;
    const travel = Math.hypot(sample.x - track.startX, sample.y - track.startY);
    const isTap = !track.moved && !track.longPressed && travel <= this.tapSlop && duration <= this.tapMaxMs;

    this.active.splice(index, 1);

    if (wasDragging) {
      this.emit({ kind: 'dragend', data: dragData });
    } else if (isTap) {
      this.emitTap(sample);
    }

    if (this.active.length < 2 && this.twoFingerActive) this.endTwoFinger(sample);
  }

  cancel(sample: InputSample): void {
    const index = this.active.findIndex((track) => track.id === sample.id);
    this.emit({ kind: 'cancel', sample });
    if (index < 0) return;
    const track = this.active[index] as Track;
    this.active.splice(index, 1);
    // 系统手势（侧滑返回、通知栏下拉）会发 pointercancel。
    // 它**不是** up：不发 tap、不发 dragend，否则侧滑返回会顺手点掉一个按钮。
    if (track.dragging) {
      this.emit({ kind: 'dragend', data: this.dragData(track, 0, 0) });
    }
    if (this.active.length < 2 && this.twoFingerActive) this.endTwoFinger(sample);
  }

  wheel(event: WheelEventLike): void {
    this.emit({ kind: 'wheel', data: event });
  }

  /**
   * 时间驱动：处理长按与「延迟单击」的超时。
   *
   * 宿主每帧调一次即可。传的是与样本同一套时间基准。
   */
  tick(now: number): void {
    for (const track of this.active) {
      if (track.longPressed) continue;
      if (this.active.length >= 2) continue; // 双指时不触发长按
      const duration = now - track.downAt;
      if (duration < this.longPressMs) continue;
      const travel = Math.hypot(track.x - track.startX, track.y - track.startY);
      if (travel > this.longPressSlop) continue;
      track.longPressed = true;
      this.emit({
        kind: 'longpress',
        data: {
          x: track.x,
          y: track.y,
          pointerType: track.pointerType,
          hitId: null,
          duration,
        },
      });
    }

    const pending = this.pendingTap;
    if (pending !== null && now - pending.t >= this.doubleTapMs) {
      this.pendingTap = null;
      // 只有延迟模式才需要在这里补发；默认模式的 tap 已经在抬手时发过了
      if (this.delayTapForDouble) {
        this.emit({
          kind: 'tap',
          data: { x: pending.x, y: pending.y, pointerType: pending.pointerType, hitId: null },
        });
      }
    }
  }

  dispose(): void {
    this.cancelPendingTap();
    this.active.length = 0;
  }

  /**
   * 单击 / 双击判定。
   *
   * **不用任何定时器**：`pendingTap` 的过期完全由 `tick(now)` 驱动。
   * 这不是洁癖 —— 手势测试要在纯 Node 里跑，而 `setTimeout` 在 Node 里返回的是
   * `Timeout` 对象（浏览器里是数字），一个 `number` 字段就能让类型在两端不一致。
   * 顺带还避开了「后台标签页定时器被节流到 1s」这个安卓 WebView 的老问题。
   */
  private emitTap(sample: InputSample): void {
    const previous = this.pendingTap;
    if (previous !== null && sample.t - previous.t <= this.doubleTapMs) {
      this.pendingTap = null;
      this.emit({
        kind: 'doubletap',
        data: {
          x: sample.x,
          y: sample.y,
          pointerType: sample.pointerType,
          hitId: null,
          interval: sample.t - previous.t,
        },
      });
      return;
    }

    // 延迟模式：先挂着，等 tick 判超期；期间若来了第二次点击就变成 doubletap
    this.pendingTap = { x: sample.x, y: sample.y, t: sample.t, pointerType: sample.pointerType };
    if (this.delayTapForDouble) return;

    // 默认模式：立刻发，同时留候选供 doubletap 判定
    this.emit({ kind: 'tap', data: { x: sample.x, y: sample.y, pointerType: sample.pointerType, hitId: null } });
  }

  /** 丢弃单击候选（读档、切场景时用）。 */
  cancelPendingTap(): void {
    this.pendingTap = null;
  }

  private find(id: number): Track | null {
    for (const track of this.active) {
      if (track.id === id) return track;
    }
    return null;
  }

  private trimSamples(track: Track, now: number): void {
    const cutoff = now - this.velocityWindowMs;
    let drop = 0;
    while (drop < track.samples.length - 2 && (track.samples[drop] as { t: number }).t < cutoff) drop += 1;
    if (drop > 0) track.samples.splice(0, drop);
  }

  private dragData(track: Track, dx: number, dy: number): {
    startX: number;
    startY: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    totalX: number;
    totalY: number;
    vx: number;
    vy: number;
  } {
    const first = track.samples[0];
    const last = track.samples[track.samples.length - 1] ?? { t: track.lastAt, x: track.x, y: track.y };
    const dt = first === undefined ? 0 : last.t - first.t;
    const vx = dt > 0 ? (last.x - (first?.x ?? last.x)) / dt : 0;
    const vy = dt > 0 ? (last.y - (first?.y ?? last.y)) / dt : 0;
    return {
      startX: track.startX,
      startY: track.startY,
      x: track.x,
      y: track.y,
      dx,
      dy,
      totalX: track.x - track.startX,
      totalY: track.y - track.startY,
      vx,
      vy,
    };
  }

  private beginTwoFinger(): void {
    const [a, b] = [this.active[0] as Track, this.active[1] as Track];
    // 参与过双指的两根手指都不能再判成点击：捏合结束时总会有一根后抬起，
    // 不标记的话「捏一下」会顺带在最后抬指的位置放一栋楼。
    a.moved = true;
    b.moved = true;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    this.pinchDistance = distance;
    this.pinchStartDistance = distance;
    this.previousDistance = distance;
    this.previousAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.previousCenterX = (a.x + b.x) / 2;
    this.previousCenterY = (a.y + b.y) / 2;
    this.twoFingerActive = true;
    this.emit({ kind: 'pinchstart', data: this.pinchData(0, 1) });
  }

  private updateTwoFinger(sample: InputSample, track: Track): void {
    if (!this.twoFingerActive) return;
    const [a, b] = [this.active[0] as Track, this.active[1] as Track];
    // 有一指刚抬起时数组长度已变，这里靠 `active` 的实际内容算，不缓存引用
    const other = a.id === track.id ? b : a;
    const distance = Math.hypot(other.x - track.x, other.y - track.y);
    const angle = Math.atan2(other.y - track.y, other.x - track.x);
    const centerX = (other.x + track.x) / 2;
    const centerY = (other.y + track.y) / 2;

    const delta = distance - this.previousDistance;
    // 缩放比用「当前 / 起始」而不是「当前 / 上一帧」：后者累乘会漂移
    const scale = this.pinchStartDistance > 0 ? distance / this.pinchStartDistance : 1;
    this.pinchDistance = distance;

    // 三种手势**同时**发，不互斥：真实捏合时手指一定会带着旋转和位移。
    // 如果做成「选一个主模式」，玩家会在捏合中途突然被切换成旋转，表现为画面一跳。
    if (Math.abs(delta) > 0) {
      this.emit({ kind: 'pinch', data: this.pinchData(delta, scale) });
    }
    const angleDelta = normalizeAngle(angle - this.previousAngle);
    if (Math.abs(angleDelta) > 1e-4) {
      this.emit({ kind: 'rotate', data: { angle, delta: angleDelta, centerX, centerY } });
    }
    const panDx = centerX - this.previousCenterX;
    const panDy = centerY - this.previousCenterY;
    if (Math.abs(panDx) > 0.01 || Math.abs(panDy) > 0.01) {
      this.emit({ kind: 'pan2', data: { centerX, centerY, dx: panDx, dy: panDy } });
    }

    this.previousDistance = distance;
    this.previousAngle = angle;
    this.previousCenterX = centerX;
    this.previousCenterY = centerY;
    void sample;
  }

  private endTwoFinger(sample: InputSample): void {
    this.twoFingerActive = false;
    this.emit({
      kind: 'pinchend',
      data: {
        distance: this.pinchDistance,
        delta: 0,
        scale: this.pinchStartDistance > 0 ? this.pinchDistance / this.pinchStartDistance : 1,
        centerX: sample.x,
        centerY: sample.y,
      },
    });
    this.pinchStartDistance = 0;
  }

  private pinchData(delta: number, scale: number): {
    distance: number;
    delta: number;
    scale: number;
    centerX: number;
    centerY: number;
  } {
    const a = this.active[0];
    const b = this.active[1];
    const centerX = a !== undefined && b !== undefined ? (a.x + b.x) / 2 : 0;
    const centerY = a !== undefined && b !== undefined ? (a.y + b.y) / 2 : 0;
    return { distance: this.pinchDistance, delta, scale, centerX, centerY };
  }
}

/** 把角度差折到 (-π, π]：不折的话跨越 ±π 会被算成「转了 350 度」。 */
export function normalizeAngle(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 把浏览器 wheel 的三种 `deltaMode` 归一化到像素。
 *
 * 三种模式的单位完全不同，不归一化的话：
 * - Firefox 默认 `DOM_DELTA_LINE`（按行），同一句 `distance += deltaY * 0.02`
 *   在 Chrome 里转 1 圈、在 Firefox 里转 0.05 圈 —— 用户会以为「缩放坏了」。
 * - `DOM_DELTA_PAGE` 更夸张，一次滚动等于一屏。
 */
export function normalizeWheel(deltaX: number, deltaY: number, deltaMode: number): { deltaX: number; deltaY: number } {
  if (deltaMode === 1) return { deltaX: deltaX * 16, deltaY: deltaY * 16 };
  if (deltaMode === 2) return { deltaX: deltaX * 100, deltaY: deltaY * 100 };
  return { deltaX, deltaY };
}
