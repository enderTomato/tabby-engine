import type { PlatformCapabilities } from './capabilities.js';

export type DeviceTier = 'low' | 'mid' | 'high';

export interface TierDecision {
  readonly tier: DeviceTier;
  /** 评分越高越强；<0 强制低端。 */
  readonly score: number;
  /** 逐条评分依据，直接展示在诊断面板上。 */
  readonly reasons: readonly string[];
  /** 是否被 GPU 黑名单强制压档。 */
  readonly forcedByGpu: boolean;
}

/**
 * 设备分档：不用「是否 Android」判断，只看可量化的能力指标。
 *
 * 权重取舍：先看 GPU 族（决定 fillrate 与驱动坑），再看内存与核数
 * （决定物理粒子上限），最后用 maxTextureSize 兜底（很多 2GB 机是 4096）。
 */
export function resolveTier(caps: PlatformCapabilities, override?: DeviceTier | null): TierDecision {
  const reasons: string[] = [];
  let score = 0;

  const add = (delta: number, reason: string): void => {
    score += delta;
    reasons.push(`${delta >= 0 ? '+' : ''}${delta} ${reason}`);
  };

  switch (caps.gpu.family) {
    case 'apple':
      add(3, 'GPU: Apple 系（统一内存，fillrate 充足）');
      break;
    case 'adreno':
      add(1, 'GPU: Adreno（驱动较新）');
      break;
    case 'mali':
      add(0, 'GPU: Mali（需按型号段判断）');
      break;
    case 'powervr':
      add(-1, 'GPU: PowerVR（驱动兼容性偏弱）');
      break;
    case 'intel':
      add(-1, 'GPU: Intel 核显（桌面，可接受）');
      break;
    case 'software':
      add(-5, 'GPU: 软件光栅化（无硬件加速）');
      break;
    default:
      add(0, `GPU: ${caps.gpu.family}`);
  }

  const mem = caps.deviceMemoryGb;
  if (mem !== null) {
    if (mem >= 8) add(2, `内存 ≥8GB (${mem})`);
    else if (mem >= 4) add(1, `内存 ≥4GB (${mem})`);
    else add(-2, `内存 ≤2GB (${mem})`);
  } else {
    reasons.push('内存: 浏览器未暴露 deviceMemory');
  }

  const cores = caps.hardwareConcurrency;
  if (cores >= 8) add(2, `CPU 核数 ${cores}`);
  else if (cores >= 6) add(1, `CPU 核数 ${cores}`);
  else if (cores <= 2) add(-2, `CPU 核数 ${cores}`);
  else add(-1, `CPU 核数 ${cores}`);

  if (caps.maxTextureSize >= 8192) add(1, `MAX_TEXTURE_SIZE ${caps.maxTextureSize}`);
  else if (caps.maxTextureSize > 0 && caps.maxTextureSize < 4096) add(-1, `MAX_TEXTURE_SIZE ${caps.maxTextureSize} 偏低`);

  if (caps.devicePixelRatio >= 3) add(-1, `DPR ${caps.devicePixelRatio}（填充率压力大）`);
  if (caps.saveData) add(-1, '用户开启省流模式');

  const forcedByGpu = caps.gpu.flags.forceLowTier;
  if (forcedByGpu) {
    reasons.push('GPU 黑名单命中，强制低端档');
  }

  let tier: DeviceTier;
  if (forcedByGpu) tier = 'low';
  else if (score >= 4) tier = 'high';
  else if (score >= 0) tier = 'mid';
  else tier = 'low';

  return { tier: override ?? tier, score, reasons, forcedByGpu };
}
