import * as THREE from 'three';

/**
 * 极简轨道相机：单指拖拽旋转、双指/滚轮缩放。
 * 不引 OrbitControls 是为了少一个 addons 依赖路径（Three 的 addons 在不同打包器下解析规则不一致）。
 */
export class OrbitController {
  target = new THREE.Vector3(0, 3.5, 0);
  distance = 24;
  theta = -0.7;
  phi = 1.02;
  minDistance = 8;
  maxDistance = 60;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pinchDistance = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly detach: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bind();
  }

  apply(camera: THREE.PerspectiveCamera): void {
    const sinPhi = Math.sin(this.phi);
    const x = this.target.x + this.distance * sinPhi * Math.sin(this.theta);
    const y = this.target.y + this.distance * Math.cos(this.phi);
    const z = this.target.z + this.distance * sinPhi * Math.cos(this.theta);
    camera.position.set(x, y, z);
    camera.lookAt(this.target);
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  private bind(): void {
    const onPointerDown = (event: PointerEvent): void => {
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.theta -= dx * 0.006;
      this.phi = Math.min(Math.max(0.25, this.phi - dy * 0.005), 1.45);
    };
    const onPointerUp = (event: PointerEvent): void => {
      this.dragging = false;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.distance = clamp(this.distance + event.deltaY * 0.02, this.minDistance, this.maxDistance);
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      if (a === undefined || b === undefined) return;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchDistance > 0) {
        this.distance = clamp(
          this.distance + (this.pinchDistance - dist) * 0.06,
          this.minDistance,
          this.maxDistance,
        );
      }
      this.pinchDistance = dist;
    };
    const onTouchEnd = (): void => {
      this.pinchDistance = 0;
    };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerup', onPointerUp);
    this.canvas.addEventListener('pointercancel', onPointerUp);
    this.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    this.canvas.addEventListener('touchend', onTouchEnd);

    this.detach.push(
      () => this.canvas.removeEventListener('pointerdown', onPointerDown),
      () => this.canvas.removeEventListener('pointermove', onPointerMove),
      () => this.canvas.removeEventListener('pointerup', onPointerUp),
      () => this.canvas.removeEventListener('pointercancel', onPointerUp),
      () => this.canvas.removeEventListener('wheel', onWheel),
      () => this.canvas.removeEventListener('touchmove', onTouchMove),
      () => this.canvas.removeEventListener('touchend', onTouchEnd),
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
