import type { PlatformCapabilities } from './capabilities.js';
import type { DeviceTier } from './tier.js';

export interface QualityProfile {
  readonly tier: DeviceTier;
  /** 目标帧率：低端允许 30fps，逻辑步长仍固定。 */
  readonly targetFps: 30 | 60;
  /** 每帧 CPU 主线程预算（毫秒）。 */
  readonly cpuBudgetMs: number;
  /** 每帧 DrawCall 上限。 */
  readonly drawCallBudget: number;
  readonly fluidParticles: number;
  readonly smokeParticles: number;
  readonly maxRagdolls: number;
  /** 渲染分辨率缩放（相对 CSS 尺寸 × DPR 的上限）。 */
  readonly renderScale: number;
  readonly maxPixelRatio: number;
  readonly antialias: boolean;
  readonly shadowQuality: 'off' | 'low' | 'high';
  /** 物理固定步频率。 */
  readonly physicsHz: 30 | 60;
  readonly preferWorker: boolean;
  /** 粒子点尺寸乘子（低端机需要更大的点来掩盖稀疏）。 */
  readonly pointsSizeScale: number;
}

const BASE: Record<DeviceTier, QualityProfile> = {
  low: {
    tier: 'low',
    targetFps: 30,
    cpuBudgetMs: 12,
    drawCallBudget: 80,
    fluidParticles: 600,
    smokeParticles: 120,
    maxRagdolls: 2,
    renderScale: 0.75,
    maxPixelRatio: 1.5,
    antialias: false,
    shadowQuality: 'off',
    physicsHz: 30,
    preferWorker: true,
    pointsSizeScale: 1.4,
  },
  mid: {
    tier: 'mid',
    targetFps: 60,
    cpuBudgetMs: 8,
    drawCallBudget: 150,
    fluidParticles: 1500,
    smokeParticles: 300,
    maxRagdolls: 4,
    renderScale: 1,
    maxPixelRatio: 2,
    antialias: false,
    shadowQuality: 'low',
    physicsHz: 60,
    preferWorker: true,
    pointsSizeScale: 1.1,
  },
  high: {
    tier: 'high',
    targetFps: 60,
    cpuBudgetMs: 8,
    drawCallBudget: 150,
    fluidParticles: 3000,
    smokeParticles: 600,
    maxRagdolls: 6,
    renderScale: 1,
    maxPixelRatio: 2,
    antialias: true,
    shadowQuality: 'high',
    physicsHz: 60,
    preferWorker: true,
    pointsSizeScale: 1,
  },
};

export function profileFor(tier: DeviceTier, caps: PlatformCapabilities): QualityProfile {
  const base = BASE[tier];
  const scale = caps.gpu.flags.particleScale;
  const cap = caps.gpu.flags.maxTextureSizeCap;
  const textureLimited = cap > 0 && caps.maxTextureSize > 0;

  return {
    ...base,
    fluidParticles: Math.max(120, Math.floor(base.fluidParticles * scale)),
    smokeParticles: Math.max(40, Math.floor(base.smokeParticles * scale)),
    antialias: base.antialias && !caps.gpu.flags.disableMsaa,
    renderScale: caps.saveData ? base.renderScale * 0.85 : base.renderScale,
    maxPixelRatio: textureLimited ? Math.min(base.maxPixelRatio, 1.5) : base.maxPixelRatio,
    preferWorker: base.preferWorker && caps.worker,
  };
}

export function describeProfile(profile: QualityProfile): string {
  return [
    `档位 ${profile.tier}`,
    `${profile.targetFps}fps`,
    `CPU预算 ${profile.cpuBudgetMs}ms`,
    `流体粒子 ${profile.fluidParticles}`,
    `烟雾粒子 ${profile.smokeParticles}`,
    `物理 ${profile.physicsHz}Hz`,
    `渲染缩放 ${profile.renderScale}`,
    `MSAA ${profile.antialias ? '开' : '关'}`,
  ].join(' · ');
}
