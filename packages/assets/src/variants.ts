/**
 * 变体回落链 —— 「给定一个资源基名，按能力排出该依次试的 URL」。
 *
 * ## 为什么排序在这里而不是在加载函数里
 *
 * 顺序是**策略**，加载是**执行**。把策略单独拎出来有三个好处：
 * 诊断面板能显示「这台机器会走哪条路」，测试能直接断言顺序，
 * 以后加 AVIF/WebP2 只改这一个文件。
 *
 * ## 为什么 KTX2 不总是排第一
 *
 * KTX2 的优势是**显存**与**解码后带宽**，不是下载体积（下载还有 gzip 帮它）。
 * 在没有任何 GPU 压缩格式的设备上，它会被转成 RGBA32，比 JPEG 大好几倍，
 * 所以这种情况下 KTX2 直接不出现 —— 而不是「排后面碰运气」。
 * 排了但不该用，等于每次启动多一次注定失败的请求。
 */

import type { AssetCapabilities } from './capability.js';

/** 一张纹理的候选列表，按优先级从高到低。 */
export interface TextureCandidates {
  readonly ktx2: string | null;
  readonly legacy: readonly string[];
}

/** 去掉扩展名，留下基名。`a/b/c.png` → `a/b/c`。 */
export function stripExtension(url: string): string {
  const slash = url.lastIndexOf('/');
  const dot = url.lastIndexOf('.');
  // 点在斜杠左边说明那是目录名里的点，不是扩展名
  if (dot <= slash) return url;
  return url.slice(0, dot);
}

/**
 * 排出一张纹理的候选 URL。
 *
 * `legacy` 里保留调用方给的顺序（比如明确想要 png 优先于 jpg 就照写的来），
 * 只是把 KTX2 插到最前面 —— 前提是这个设备真能用 KTX2。
 */
export function textureCandidates(base: string, caps: AssetCapabilities, legacy: readonly string[] = ['png', 'jpg']): TextureCandidates {
  const stem = stripExtension(base);
  // base 本身已经带 .ktx2 时不要再拼一层
  const ktx2 = caps.ktx2 ? (stem.toLowerCase().endsWith('.ktx2') ? stem : `${stem}.ktx2`) : null;
  return { ktx2, legacy: legacy.map((ext) => `${stem}.${ext}`) };
}

/**
 * 排出一次加载的完整尝试顺序：KTX2 在前（若可用），未压缩在后。
 *
 * 加起来是空数组说明调用方两样都没给 —— 这属于接线错误，应当早点抛。
 */
export function resolveTextureChain(base: string, caps: AssetCapabilities, legacy: readonly string[] = ['png', 'jpg']): string[] {
  const { ktx2, legacy: fallbacks } = textureCandidates(base, caps, legacy);
  const chain = ktx2 === null ? [...fallbacks] : [ktx2, ...fallbacks];
  if (chain.length === 0) throw new Error(`资源 ${base} 没有任何可用的候选格式`);
  return chain;
}

/** 网格的候选：DRACO 压缩版（`.glb` 内部就是 draco）就是同一个文件，不需要换 URL。 */
export interface MeshCandidate {
  readonly url: string;
  /** 是否需要挂 DRACO 解码器。 */
  readonly compressed: boolean;
}

/**
 * 排网格候选。
 *
 * 与纹理不同，DRACO 是**容器内的压缩**，文件名不变（仍是 .glb），
 * 所以这里不产生两个 URL，而是标记「这个文件要不要挂解码器」。
 * 于是「能不能解码」直接决定「能不能加载」，没有中间态 ——
 * 这也是为什么 `draco: false` 时必须由调用方提供未压缩的备用文件。
 */
export function meshCandidates(compressedUrl: string, plainUrl: string | null, caps: AssetCapabilities): MeshCandidate[] {
  const chain: MeshCandidate[] = [];
  if (caps.draco) chain.push({ url: compressedUrl, compressed: true });
  if (plainUrl !== null) chain.push({ url: plainUrl, compressed: false });
  if (chain.length === 0) {
    throw new Error(`网格 ${compressedUrl} 既不能解码又没有未压缩备用文件`);
  }
  return chain;
}
