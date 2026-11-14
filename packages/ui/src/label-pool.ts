/**
 * DOM 标签池 —— 3D 场景里的浮动标签（建筑名、效率百分比）。
 *
 * ## 为什么用 DOM 而不是在 canvas 里画字
 *
 * 3D 世界里的中文标签要抗锯齿、要跟随系统字体缩放、要能被无障碍工具读到。
 * 在 WebGL 里画中文意味着自带字体图集（几百 KB）并且失去前面三样。
 * 20 个标签用 DOM 逐个 `translate3d` 的成本远低于维护一整套 SDF 字形。
 *
 * ## 池化的是「元素」而不是「字符串」
 *
 * 每帧 `createElement` 在 Android 上是可感知的卡顿源。所以元素只增不减，
 * 本帧用不到的靠 `visibility: hidden` 藏起来 —— 那只是重绘，不触发重排；
 * 而 `display: none` ↔ `''` 会触发整棵子树的布局。
 *
 * ## 两段式赋值
 *
 * 标签的「位置」每帧都变，「文字」10Hz 才变一次。所以位置每帧写，
 * 文字走差异比较：值没变就不碰 `textContent` —— 写 `textContent` 会让浏览器
 * 丢弃该节点的文本布局缓存，20 个标签每帧写一遍等于每帧重排 20 次。
 */

/** 一个标签此刻的完整视觉状态。调用方每帧给一份，池子负责把它落到 DOM。 */
export interface LabelVisual {
  /** 元素内坐标（CSS 像素）。 */
  readonly x: number;
  readonly y: number;
  /** 缩放系数，1 为原尺寸。 */
  readonly scale: number;
  readonly visible: boolean;
  readonly text: string;
  /** 附加「坏状态」样式类（断供变红之类）。 */
  readonly bad?: boolean;
}

export interface LabelPoolOptions {
  /** 标签基础类名，默认 `float-label`。 */
  readonly className?: string;
  /** 「坏状态」附加类名，默认 `bad`。 */
  readonly badClassName?: string;
  /**
   * 位置比较的小数位。
   *
   * 默认 1 —— 亚像素级别的变化肉眼看不见，但会让 `transform` 字符串每次都不同，
   * 从而每帧都真的改一次样式。截到 0.1px 能把"没动的标签"的写入降到 0。
   */
  readonly positionPrecision?: number;
}

interface Slot {
  readonly el: HTMLDivElement;
  text: string;
  bad: boolean;
  transform: string;
  visible: boolean;
}

export class LabelPool {
  readonly container: HTMLElement;
  private readonly slots: Slot[] = [];
  private readonly className: string;
  private readonly badClassName: string;
  private readonly digits: number;
  /** 累计真正写进 DOM 的 transform 次数，诊断用（远小于帧数说明差异比较生效）。 */
  private transformWrites = 0;
  private textWrites = 0;
  private disposed = false;

  constructor(container: HTMLElement, options: LabelPoolOptions = {}) {
    this.container = container;
    this.className = options.className ?? 'float-label';
    this.badClassName = options.badClassName ?? 'bad';
    this.digits = options.positionPrecision ?? 1;
  }

  get count(): number {
    return this.slots.length;
  }

  /** 累计写 DOM 的统计，接到诊断面板上能直接看出差异比较有没有偷懒。 */
  get stats(): { readonly slots: number; readonly transformWrites: number; readonly textWrites: number } {
    return { slots: this.slots.length, transformWrites: this.transformWrites, textWrites: this.textWrites };
  }

  /**
   * 把一批标签状态落到 DOM。第 i 项对应第 i 个元素；多的元素自动隐藏。
   *
   * 隐藏时保留上一次的 transform：重新显示时就不用再算一遍位置，
   * 也避免了「刚显示的那一帧出现在 (0,0)」的闪烁。
   */
  apply(items: readonly LabelVisual[]): void {
    if (this.disposed) return;
    const scaleDigits = 2;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined) continue;
      const slot = this.slotAt(i);
      if (!item.visible) {
        if (slot.visible) {
          slot.el.style.visibility = 'hidden';
          slot.el.style.pointerEvents = 'none';
          slot.visible = false;
        }
        continue;
      }
      if (!slot.visible) {
        slot.el.style.visibility = '';
        slot.el.style.pointerEvents = '';
        slot.visible = true;
      }
      const transform =
        `translate3d(${item.x.toFixed(this.digits)}px, ${item.y.toFixed(this.digits)}px, 0)` +
        ` scale(${item.scale.toFixed(scaleDigits)})`;
      if (transform !== slot.transform) {
        slot.el.style.transform = transform;
        slot.transform = transform;
        this.transformWrites += 1;
      }
      if (item.text !== slot.text) {
        slot.el.textContent = item.text;
        slot.text = item.text;
        this.textWrites += 1;
      }
      const bad = item.bad === true;
      if (bad !== slot.bad) {
        slot.el.classList.toggle(this.badClassName, bad);
        slot.bad = bad;
      }
    }
    for (let i = items.length; i < this.slots.length; i += 1) {
      const slot = this.slots[i];
      if (slot !== undefined && slot.visible) {
        slot.el.style.visibility = 'hidden';
        slot.el.style.pointerEvents = 'none';
        slot.visible = false;
      }
    }
  }

  /** 全部隐藏（切到 2D 模式、离开 3D 视角时用）。 */
  hideAll(): void {
    for (const slot of this.slots) {
      if (slot.visible) {
        slot.el.style.visibility = 'hidden';
        slot.el.style.pointerEvents = 'none';
        slot.visible = false;
      }
    }
  }

  /**
   * 移除全部元素并把池子标记为已销毁。
   *
   * 调用后 `apply` 变成空操作 —— 组件的卸载顺序不一定可控，
   * 与其指望调用方不再调用，不如让销毁本身幂等。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.el.remove();
    }
    this.slots.length = 0;
  }

  private slotAt(index: number): Slot {
    let slot = this.slots[index];
    if (slot === undefined) {
      const el = document.createElement('div');
      el.className = this.className;
      el.style.visibility = 'hidden';
      el.style.willChange = 'transform';
      this.container.appendChild(el);
      slot = { el, text: '', bad: false, transform: '', visible: false };
      this.slots[index] = slot;
    }
    return slot;
  }
}
