/**
 * `@tabby/assets` —— 资源加载与降级。
 *
 * 三层职责，分得很硬：
 *
 * 1. **能力探测**（`capability.ts`）：这台设备到底能不能用压缩纹理/压缩网格。
 *    只问能力，不问平台 —— `isAndroid` 这种判断在碎片化面前必错。
 * 2. **策略**（`variants.ts`）：按能力排出候选链。策略与执行分离，
 *    才能既在诊断面板上显示「会走哪条路」，又能在测试里断言顺序。
 * 3. **执行与缓存**（`cache.ts` / `three-host.ts`）：引用计数、延迟释放、
 *    并发合并、失败缓存。这些与 three 无关，所以 `cache.ts` 可以在 Node 里跑测试。
 *
 * 解码器（basis 576KB + draco 340KB）**永远不进主包**，由部署方托管在
 * `public/decoders/`，只在真正加载压缩资源时才按需 fetch。见 `docs/ASSETS.md`。
 */

export * from './capability.js';
export * from './variants.js';
export * from './cache.js';
export * from './three-host.js';
