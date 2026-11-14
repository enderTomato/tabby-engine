import type { FrameInfo } from '@tabby/core';
import type { PlatformCapabilities, QualityProfile } from '@tabby/platform';
import type { Engine } from './engine.js';

export interface ViewFrame {
  readonly frame: FrameInfo;
  readonly alpha: number;
  readonly deltaMs: number;
  readonly profile: QualityProfile;
}

export interface ViewContext {
  readonly engine: Engine;
  readonly caps: PlatformCapabilities;
  readonly profile: QualityProfile;
}

/**
 * 视图适配器（渲染层唯一对引擎暴露的接口）。
 *
 * 引擎不认识 Three/Pixi，只按顺序调用 attach → resize → render。
 * 这样 `@tabby/render3d` 可以整个不装，引擎照常跑逻辑（无头模拟 / 服务器端校验）。
 */
export interface ViewAdapter {
  readonly id: string;
  /** 越小越先渲染（背景层）。缺省 0。 */
  readonly order?: number;
  attach(context: ViewContext): Promise<void> | void;
  resize(width: number, height: number, dpr: number): void;
  render(frame: ViewFrame): void;
  /** 自适应降级时下发新档位，视图据此调整分辨率/MSAA 等。 */
  applyProfile?(profile: QualityProfile): void;
  /** 多视图切换（如 2D/3D 分页）时通知，false 表示本帧可不渲染。 */
  setActive?(active: boolean): void;
  dispose(): void;
}

export interface FrameStats {
  readonly fps: number;
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly fixedSteps: number;
  readonly droppedMs: number;
  readonly fluidParticles: number;
  readonly smokeParticles: number;
  readonly drawCallsHint: number;
}
