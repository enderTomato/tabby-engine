/**
 * GPU 能力画像与黑名单。
 *
 * 只认 renderer 字符串，不做「是否 Android」的整机判断——
 * 同一台机器上不同浏览器可能给出不同的 renderer，
 * 而同一颗 SoC 在不同驱动版本下行为也可能不同，所以规则按
 * 「族 + 型号段 + 驱动特征」匹配，命中后只降级对应能力。
 */

export type GpuFamily =
  | 'mali'
  | 'adreno'
  | 'powervr'
  | 'apple'
  | 'intel'
  | 'nvidia'
  | 'amd'
  | 'software'
  | 'unknown';

export interface GpuFlags {
  /** 关闭依赖浮点纹理的路径（流体/GPGPU 回退到 CPU）。 */
  readonly disableFloatTextures: boolean;
  /** 关闭 MSAA（老 Mali/PowerVR 的 blit 有灰边/黑屏报告）。 */
  readonly disableMsaa: boolean;
  /** 关闭 InstancedMesh（部分 PowerVR 驱动 instancing 属性错位）。 */
  readonly disableInstancing: boolean;
  /** 纹理边长上限（0 表示不额外限制）。 */
  readonly maxTextureSizeCap: number;
  /** 粒子数量乘子，0~1。 */
  readonly particleScale: number;
  /** 无论评分如何都压到低端档。 */
  readonly forceLowTier: boolean;
}

export interface GpuVerdict {
  readonly family: GpuFamily;
  readonly vendor: string;
  readonly renderer: string;
  readonly software: boolean;
  readonly flags: GpuFlags;
  readonly notes: readonly string[];
  /** 命中的规则 id，便于线上日志归类。 */
  readonly ruleIds: readonly string[];
}

export const DEFAULT_GPU_FLAGS: GpuFlags = {
  disableFloatTextures: false,
  disableMsaa: false,
  disableInstancing: false,
  maxTextureSizeCap: 0,
  particleScale: 1,
  forceLowTier: false,
};

interface GpuRule {
  readonly id: string;
  readonly match: RegExp;
  readonly family?: GpuFamily;
  readonly note: string;
  readonly flags: Partial<GpuFlags>;
}

const RULES: readonly GpuRule[] = [
  {
    id: 'swiftshader',
    match: /swiftshader|llvmpipe|software rast|basic render/i,
    family: 'software',
    note: '软件光栅化（模拟器/远程桌面/被禁 GPU），强制低端档',
    flags: { forceLowTier: true, particleScale: 0.3, disableMsaa: true, disableFloatTextures: true },
  },
  {
    id: 'mali-4xx',
    match: /mali-4\d\d/i,
    family: 'mali',
    note: 'Mali-4xx 为 32 位浮点管线，片元 highp 精度不可靠，关闭浮点纹理与 MSAA',
    flags: {
      disableFloatTextures: true,
      disableMsaa: true,
      particleScale: 0.5,
      maxTextureSizeCap: 4096,
    },
  },
  {
    id: 'mali-t6xx-t7xx',
    match: /mali-t[67]\d\d/i,
    family: 'mali',
    note: 'Mali-T6xx/T7xx 驱动 MSAA blit 存在历史黑屏/彩边问题，降级为无 MSAA',
    flags: { disableMsaa: true, particleScale: 0.7 },
  },
  {
    id: 'powervr-rogue-low',
    match: /powervr\s*(ge8[0-9]{3}|ge7[0-9]{3}|g6[0-9]{3})/i,
    family: 'powervr',
    note: 'PowerVR Rogue 低段缺少 OES_texture_half_float_linear，instancing 属性绑定不稳',
    flags: {
      disableFloatTextures: true,
      disableMsaa: true,
      disableInstancing: true,
      particleScale: 0.6,
    },
  },
  {
    id: 'vivante',
    match: /vivante|gc\d{4}/i,
    family: 'unknown',
    note: 'Vivante GC 系驱动对 WebGL2 支持不完整，保守降级',
    flags: { forceLowTier: true, particleScale: 0.4, disableInstancing: true },
  },
  {
    id: 'adreno-3xx-4xx',
    match: /adreno\s*\(tm\)\s*[34]\d\d/i,
    family: 'adreno',
    note: 'Adreno 3xx/4xx 驱动在 WebGL2 MSAA 与浮点纹理上有已知花屏报告',
    flags: { disableMsaa: true, disableFloatTextures: true, particleScale: 0.6 },
  },
  {
    id: 'adreno-5xx',
    match: /adreno\s*\(tm\)\s*5\d\d/i,
    family: 'adreno',
    note: 'Adreno 5xx 可用，保守不做 MSAA',
    flags: { disableMsaa: true, particleScale: 0.85 },
  },
  {
    id: 'desktop-angle',
    match: /angle\s*\((nvidia|amd|intel|microsoft)/i,
    note: '桌面 ANGLE 后端（D3D11），按对应族处理即可',
    flags: {},
  },
];

const FAMILY_MATCHERS: readonly (readonly [RegExp, GpuFamily])[] = [
  [/mali/i, 'mali'],
  [/adreno/i, 'adreno'],
  [/powervr|imagination/i, 'powervr'],
  [/apple\s*(gpu|m\d)/i, 'apple'],
  [/(intel|mesa intel)/i, 'intel'],
  [/(nvidia|geforce|quadro)/i, 'nvidia'],
  [/(amd|radeon)/i, 'amd'],
  [/swiftshader|llvmpipe|software/i, 'software'],
];

export function evaluateGpu(vendor: string, renderer: string): GpuVerdict {
  const haystack = `${vendor} ${renderer}`;
  const notes: string[] = [];
  const ruleIds: string[] = [];
  const flags: GpuFlags = { ...DEFAULT_GPU_FLAGS };

  let family: GpuFamily = 'unknown';
  for (const [pattern, name] of FAMILY_MATCHERS) {
    if (pattern.test(haystack)) {
      family = name;
      break;
    }
  }

  for (const rule of RULES) {
    if (!rule.match.test(haystack)) continue;
    ruleIds.push(rule.id);
    notes.push(`[${rule.id}] ${rule.note}`);
    Object.assign(flags, rule.flags);
    if (rule.family !== undefined) family = rule.family;
  }

  const software = family === 'software';

  return {
    family,
    vendor,
    renderer,
    software,
    flags: software ? { ...flags, forceLowTier: true } : flags,
    notes,
    ruleIds,
  };
}
