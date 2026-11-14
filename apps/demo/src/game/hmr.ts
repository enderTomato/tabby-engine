/**
 * 配置表热重载的 HMR 接线。
 *
 * ## 这里为什么必须存在
 *
 * `import.meta.hot.accept(...)` 的回调拿到的是**新的模块命名空间**，
 * 而 `CitySimulation` 构造时已经把旧的那份表塞进了 `Economy`。
 * 光靠 Vite 替换模块对象，跑着的实例不会有任何变化 ——
 * 症状是「改了 defs.ts 里的数值，页面上的产量纹丝不动」，
 * 然后所有人开始怀疑热重载坏了。
 *
 * 所以这条线的作用是：模块一换，就把新表**主动推**进 `ConfigHost`，
 * 由订阅方（App.vue）决定是「重建实例」还是「只提示」。
 *
 * ## 为什么 accept 的路径带了包名
 *
 * 玩法层拆成 `@tabby/gameplay` 之后，`defs.ts` 已经不在应用源码树里了。
 * `@tabby/gameplay/defs` 这个子路径**只存在于 vite.config.ts 的 alias 里**，
 * `package.json` 的 exports 并没有它 —— 这是有意的：
 * 它只是开发期的热替换通道，构建期没人会 import 这个路径。
 * 若 alias 被删掉，这条 accept 会静默失效，页面退化成「整页刷新」，
 * 而不会报错 —— 所以改动 alias 时要连这里一起想。
 *
 * ## 为什么只接受 defs，不接受整个包
 *
 * `accept` 的依赖清单同时是「热重载的契约边界」：
 * 改 `defs.ts` 只重建实例（状态保住）；改 `simulation.ts` 会整页刷新（状态丢失）。
 * 若 accept 整个包，改 `simulation.ts` 也会走到这个回调里被当成「表变了」，
 * 于是「重建实例」被误触发 —— 表现为状态莫名其妙被清空。
 */

import { configHost } from '@tabby/gameplay';

if (import.meta.hot) {
  /**
   * 改 `defs.ts`：从新模块里取表。
   *
   * `config` 走 `{...}` 展开是必须的 —— `DEMO_CONFIG` 是 `readonly` 对象，
   * 直接引用新模块的引用会让 `ConfigHost` 里的旧表与新表共享同一份 config，
   * 于是「取消了热重载」这种诡异现象会出现（因为旧表也被改了）。
   */
  import.meta.hot.accept('@tabby/gameplay/defs', (mod) => {
    if (mod === undefined) return;
    configHost.apply(
      {
        resources: mod.DEMO_RESOURCES,
        buildings: mod.DEMO_BUILDINGS,
        config: { ...mod.DEMO_CONFIG },
      },
      'builtin',
    );
  });

  /**
   * 改 `public/config/table.json` 不会触发任何模块热替换（它不在模块图里），
   * 所以只能在页面上提供一个「重读配置」按钮（见 App.vue 的诊断面板）。
   * 这里把地址暴露出去，避免按钮里再硬编码一遍。
   */
  import.meta.hot.dispose(() => {
    // 热重载过程中不要残留上一个实例的订阅，否则一次热替换会重建两次
    configHost.resetSubscribers();
  });
}
