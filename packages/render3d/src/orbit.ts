import * as THREE from 'three';
import { OrbitDriver, type OrbitState } from '@tabby/input';

export interface OrbitControllerOptions {
  /**
   * 是否自己绑 DOM 事件。默认 true（独立使用）。
   *
   * 集成 `@tabby/input` 的 `InputManager` 时传 `false`：两套都绑会让一次拖动
   * 被处理两遍，表现为「转得比手快一倍」。
   */
  readonly manageInput?: boolean;
  readonly driver?: OrbitDriver;
}

/**
 * 轨道相机：单指拖拽旋转、双指捏合缩放、滚轮缩放、松手带惯性。
 *
 * 状态全部交给 `@tabby/input` 的 `OrbitDriver`：
 * - 手感参数（灵敏度、阻尼、上下界）只在一处定义；
 * - 惯性曲线能在纯 Node 里测（`OrbitDriver` 不依赖 three）；
 * - 同一套输入可以同时驱动相机和其它系统。
 *
 * 这个类剩下的职责只有两件：把手势喂给 driver，把 driver 的状态写成 THREE 相机矩阵。
 */
export class OrbitController {
  private readonly driver: OrbitDriver;
  private readonly detach: (() => void)[] = [];
  private lastX = 0;
  private lastY = 0;
  private dragging = false;
  private pinchDistance = 0;
  /** 上一帧时间戳，用于惯性积分。0 表示还没收到过帧。 */
  private lastFrameMs = 0;

  constructor(canvas: HTMLCanvasElement | null, options: OrbitControllerOptions = {}) {
    this.driver =
      options.driver ??
      new OrbitDriver({
        theta: -0.7,
        phi: 1.02,
        distance: 24,
        minDistance: 8,
        maxDistance: 60,
      });
    // 目标点抬到建筑腰部，否则镜头永远盯着地面
    this.driver.set({ targetY: 3.5 });
    if (options.manageInput !== false && canvas !== null) this.bind(canvas);
  }

  // ---- 保留原有字段名：view3d 与既有代码都在用 theta / phi / distance ----
  get theta(): number {
    return this.driver.state.theta;
  }

  set theta(value: number) {
    this.driver.set({ theta: value });
  }

  get phi(): number {
    return this.driver.state.phi;
  }

  set phi(value: number) {
    this.driver.set({ phi: value });
  }

  get distance(): number {
    return this.driver.state.distance;
  }

  set distance(value: number) {
    this.driver.set({ distance: value });
  }

  get minDistance(): number {
    return 8;
  }

  get maxDistance(): number {
    return 60;
  }

  get state(): OrbitState {
    return this.driver.state;
  }

  /** 暴露 driver：集成方可以把同一套手势同时喂给相机和其它系统。 */
  get orbitDriver(): OrbitDriver {
    return this.driver;
  }

  apply(camera: THREE.PerspectiveCamera): void {
    const state = this.driver.state;
    const eye = this.driver.eye();
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(state.targetX, state.targetY, state.targetZ);
  }

  /**
   * 推进惯性。**必须每帧调用**，传真实时间戳（毫秒）。
   *
   * 传固定 16.67 的话，30fps 设备上惯性会慢一倍 —— 这个差异在低端机上非常明显。
   */
  update(nowMs: number): void {
    if (this.lastFrameMs === 0) {
      this.lastFrameMs = nowMs;
      return;
    }
    const dt = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    if (dt <= 0) return;
    this.driver.update(dt);
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  private bind(canvas: HTMLCanvasElement): void {
    const onPointerDown = (event: PointerEvent): void => {
      this.dragging = true;
      this.driver.stop(); // 再次按下立刻停住惯性，否则"抓住"的手感很怪
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // 合成事件可能没有可捕获的指针
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.driver.drag(dx, dy);
    };
    const onPointerUp = (event: PointerEvent): void => {
      this.dragging = false;
      try {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略
      }
      // 自己绑事件时拿不到速度样本，只能「不快滑」。要惯性就接 InputManager。
      this.driver.release(0, 0);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      // deltaMode 必须归一化，否则 Firefox 上的滚轮效果是 Chrome 的十几倍
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      this.driver.wheel(event.deltaY * scale);
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return;
      const a = event.touches[0];
      const b = event.touches[1];
      if (a === undefined || b === undefined) return;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchDistance > 0) {
        // 用「相对上一帧的比值」推出一个等效 scale，避免每次都要记住起始间距
        this.driver.pinch(dist / this.pinchDistance, this.driver.state.distance);
      }
      this.pinchDistance = dist;
    };
    const onTouchEnd = (): void => {
      this.pinchDistance = 0;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd);

    this.detach.push(
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => canvas.removeEventListener('pointermove', onPointerMove),
      () => canvas.removeEventListener('pointerup', onPointerUp),
      () => canvas.removeEventListener('pointercancel', onPointerUp),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('touchmove', onTouchMove),
      () => canvas.removeEventListener('touchend', onTouchEnd),
    );
  }
}
