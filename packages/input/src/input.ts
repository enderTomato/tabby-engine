import { GestureRecognizer, normalizeWheel, type GestureOptions } from './gestures.js';
import { Haptics, type HapticsOptions } from './haptics.js';
import { hitTest, type HitArea } from './hit-area.js';
import type { GestureEvent, InputSample, WheelEventLike } from './types.js';

export interface InputManagerOptions extends GestureOptions {
  /** 触感配置。不传则用默认（开启）。 */
  readonly haptics?: HapticsOptions;
  /** 注入时钟（毫秒）。默认 `performance.now()`。测试里换成假时钟。 */
  readonly now?: () => number;
  /**
   * 是否接管 `touch-action`。默认 true。
   *
   * 设成 `none` 是**必须的**：不加的话，安卓 Chrome 会把单指拖动当成页面滚动，
   * 我们在 `pointermove` 里收到的第一帧就已经是「滚动被系统接管」之后的状态，
   * 表现为「拖不动」或「拖到一半突然松手」。iOS 上更糟，会触发橡皮筋回弹。
   */
  readonly manageTouchAction?: boolean;
  /** 是否阻止长按弹出的系统菜单（安卓的文本选择 / 图片保存菜单）。默认 true。 */
  readonly suppressContextMenu?: boolean;
}

/**
 * 统一输入门面。
 *
 * 职责边界：
 * - **只做翻译**：DOM 事件 → `InputSample` → `GestureEvent`。不解释语义
 *   （「点到建筑该干什么」是玩法层的事）。
 * - **只挂不抢**：不 `stopPropagation`，不阻止页面其它监听器。要阻止的只有
 *   默认行为（滚动、缩放、长按菜单），且都限定在目标元素上。
 * - **无分配热路径**：`pointermove` 每帧都可能来几十次，样本对象是复用的。
 */
export class InputManager {
  readonly haptics: Haptics;
  private readonly element: HTMLElement;
  private readonly recognizer: GestureRecognizer;
  private readonly listeners: ((event: GestureEvent) => void)[] = [];
  private readonly now: () => number;
  private readonly detach: (() => void)[] = [];
  private areas: readonly HitArea[] = [];
  private rect = { left: 0, top: 0, width: 0, height: 0 };
  private lastTickAt = 0;
  private disposed = false;

  constructor(element: HTMLElement, options: InputManagerOptions = {}) {
    this.element = element;
    this.now = options.now ?? (() => performance.now());
    this.haptics = new Haptics(options.haptics);
    this.recognizer = new GestureRecognizer((event) => this.dispatch(event), options);
    if (options.manageTouchAction !== false) this.applyTouchAction();
    if (options.suppressContextMenu !== false) this.suppressContextMenu();
    this.bind();
    this.refreshRect();
  }

  /** 订阅手势事件。返回退订函数。 */
  on(listener: (event: GestureEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /** 替换热区表。点击事件会自动带上命中的 `hitId`。 */
  setHitAreas(areas: readonly HitArea[]): void {
    this.areas = areas;
  }

  /** 元素尺寸变化后调用（`ResizeObserver` 里）。缓存 rect 是为了免掉每次事件的 layout */
  refreshRect(): void {
    const box = this.element.getBoundingClientRect();
    this.rect = { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  /**
   * 推进时间，处理长按与单击超期。
   *
   * 宿主每帧调一次。不用 `setInterval` 的原因见 `GestureRecognizer.tick` 的注释：
   * 后台标签页的定时器会被节流到 1s 以上，切回来时集中补发。
   */
  update(): void {
    if (this.disposed) return;
    const now = this.now();
    // 同一毫秒内重复调用没有意义（一帧内可能被多个系统调一次）
    if (now <= this.lastTickAt) return;
    this.lastTickAt = now;
    this.recognizer.tick(now);
  }

  dispose(): void {
    this.disposed = true;
    this.recognizer.dispose();
    for (const off of this.detach) off();
    this.detach.length = 0;
    this.listeners.length = 0;
  }

  private applyTouchAction(): void {
    // `none` 而不是 `manipulation`：后者仍允许平移，安卓上双指缩放会被浏览器吃掉。
    // 用内联样式而不是 class，避免宿主不引 CSS 时静默失效。
    this.element.style.touchAction = 'none';
    // iOS Safari 的旧属性，仍在很多 WebView 里生效
    (this.element.style as unknown as { webkitUserSelect?: string }).webkitUserSelect = 'none';
  }

  private suppressContextMenu(): void {
    const handler = (event: Event): void => event.preventDefault();
    this.element.addEventListener('contextmenu', handler);
    this.detach.push(() => this.element.removeEventListener('contextmenu', handler));
  }

  private bind(): void {
    // pointer 事件全部用 `{ passive: false }`：拖拽/缩放需要 preventDefault 才有意义。
    // 注意 `passive: true` 时 preventDefault 会被静默忽略（Chrome 只在控制台警告一次），
    // 于是「滚动没被阻止」这个问题在真机上表现为随机复现。
    const opts: AddEventListenerOptions = { passive: false };

    const down = (event: PointerEvent): void => {
      this.refreshRect();
      // 捕获指针：手指滑出 canvas 之后仍能收到 move/up，
      // 否则拖到屏幕边缘会「松手」，轨道相机停在半路
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // 某些环境（合成事件、已释放）会抛，忽略了事
      }
      if (event.pointerType === 'touch') event.preventDefault();
      this.recognizer.down(this.sample(event));
    };
    const move = (event: PointerEvent): void => {
      this.recognizer.move(this.sample(event));
    };
    const up = (event: PointerEvent): void => {
      try {
        if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略
      }
      this.recognizer.up(this.sample(event));
    };
    const cancel = (event: PointerEvent): void => {
      this.recognizer.cancel(this.sample(event));
    };
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const normalized = normalizeWheel(event.deltaX, event.deltaY, event.deltaMode);
      const point = this.pointOf(event.clientX, event.clientY);
      const payload: WheelEventLike = {
        deltaX: normalized.deltaX,
        deltaY: normalized.deltaY,
        // 触控板捏合在 Chrome 里报成 ctrl+wheel；不识别它，缩放会变成"滚得飞快"
        zoomIntent: event.ctrlKey,
        x: point.x,
        y: point.y,
      };
      this.recognizer.wheel(payload);
    };

    this.element.addEventListener('pointerdown', down, opts);
    this.element.addEventListener('pointermove', move, opts);
    this.element.addEventListener('pointerup', up, opts);
    this.element.addEventListener('pointercancel', cancel, opts);
    // 指针离开窗口（拖到浏览器外放开）不会发 pointerup，只有 pointerleave。
    // 不处理的话拖拽状态会永久卡住。
    this.element.addEventListener('pointerleave', cancel, opts);
    this.element.addEventListener('wheel', wheel, opts);

    this.detach.push(
      () => this.element.removeEventListener('pointerdown', down, opts),
      () => this.element.removeEventListener('pointermove', move, opts),
      () => this.element.removeEventListener('pointerup', up, opts),
      () => this.element.removeEventListener('pointercancel', cancel, opts),
      () => this.element.removeEventListener('pointerleave', cancel, opts),
      () => this.element.removeEventListener('wheel', wheel, opts),
    );
  }

  private sample(event: PointerEvent): InputSample {
    const point = this.pointOf(event.clientX, event.clientY);
    return {
      id: event.pointerId,
      x: point.x,
      y: point.y,
      t: this.now(),
      pointerType: event.pointerType === 'mouse' || event.pointerType === 'pen' ? event.pointerType : 'touch',
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  private pointOf(clientX: number, clientY: number): { x: number; y: number } {
    // client 坐标是**视口**坐标，必须减去元素偏移；
    // 忘了减的话，页面一滚动点击位置就整体偏掉（最经典的移动端 bug）
    return { x: clientX - this.rect.left, y: clientY - this.rect.top };
  }

  private dispatch(event: GestureEvent): void {
    const enriched = this.enrich(event);
    for (const listener of this.listeners) listener(enriched);
    this.feedback(enriched);
  }

  /** 给点击类事件补上命中的热区 id。 */
  private enrich(event: GestureEvent): GestureEvent {
    switch (event.kind) {
      case 'tap': {
        const hit = hitTest(this.areas, event.data.x, event.data.y);
        if (hit === null) return event;
        return { kind: 'tap', data: { ...event.data, hitId: hit.id } };
      }
      case 'longpress': {
        const hit = hitTest(this.areas, event.data.x, event.data.y);
        if (hit === null) return event;
        return { kind: 'longpress', data: { ...event.data, hitId: hit.id } };
      }
      case 'doubletap': {
        const hit = hitTest(this.areas, event.data.x, event.data.y);
        if (hit === null) return event;
        return { kind: event.kind, data: { ...event.data, hitId: hit.id } };
      }
      default:
        return event;
    }
  }

  /**
   * 默认的触感反馈。
   *
   * 只给 tap / longpress / dragstart 三类震：这三类在手机上「没有视觉反馈」也说得过去，
   * 但玩家会怀疑没点上。拖拽中途、双指、滚轮都不震 —— 那些场景一直在动，震起来像故障。
   */
  private feedback(event: GestureEvent): void {
    if (!this.haptics.isEnabled) return;
    if (event.kind === 'tap') this.haptics.tick();
    else if (event.kind === 'longpress') this.haptics.impact();
    else if (event.kind === 'dragstart') this.haptics.tick();
  }
}
