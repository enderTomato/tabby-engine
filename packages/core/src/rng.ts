/**
 * 确定性伪随机数（xoshiro128** + splitmix32 播种）。
 *
 * 为什么不用 Math.random：物理回放在 Worker / 主线程之间必须一致，
 * 且故障复现需要「同一 seed → 同一序列」。xoshiro128** 纯 32 位整数运算，
 * 在 ARMv7 设备上也不依赖浮点一致性。
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed = 0x9e3779b9) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    let state = seed >>> 0;
    const next = (): number => {
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 0x9e3779b9;
    }
  }

  /** [0, 1) 均匀分布。 */
  next(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) / 4294967296;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** 整数区间 [min, maxExclusive)。 */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[], fallback: T): T {
    if (items.length === 0) return fallback;
    return items[Math.floor(this.next() * items.length)] ?? fallback;
  }

  /** 对称抖动，幅度 ±amount。 */
  jitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
