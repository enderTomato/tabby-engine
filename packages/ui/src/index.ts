/**
 * `@tabby/ui` —— 框架无关的 UI 原语。
 *
 * 这里的每一样东西都满足同一个判据：**换掉玩法、换掉框架，它还得在**。
 * 所以这个包不认识经济、不认识城市、也不 import Vue —— 它只认
 * 「一块格子值数组」「一批要落到 DOM 的标签」「一组要写回世界的旋钮」。
 *
 * 用到它的应用自己决定怎么渲染：Vue 组件、原生 DOM、甚至画到 canvas 都行。
 */

export * from './minimap.js';
export * from './label-pool.js';
export * from './knobs.js';
export * from './toast.js';
