/**
 * 配置表热重载的 HMR 接线。
 *
 * ## 这里为什么必须存在
 *
 * `import.meta.hot.accept('./defs', cb)` 的回调拿到的是**新的模块命名空间**，
 * 而 `CitySimulation` 构造时已经把旧的那份表塞进了 `Economy`。
 * 光靠 Vite 替换模块对象，跑着的实例不会有任何变化 ——
 * 症状是「改了 defs.ts 里的数值，页面上的产量纹丝不动」，
 * 然后所有人开始怀疑热重载坏了。
 *
 * 所以这条线的作用是：模块一换，就把新表**主动推**进 `ConfigHost`，
 * 由订阅方（App.vue）决定是「重建实例」还是「只提示」。
 *
 * ## 为什么只接受 defs.ts 和 table.json，不接受别的
 *
 * `accept` 的依赖清单同时是「热重载的契约边界」：
 * 改 `simulation.ts` 会整页刷新（状态丢失），改 `defs.ts` 只重建实例。
 * 把边界画清楚，改表的人就知道自己的改动能保到什么程度。
 */

import { configHost } from './config-loader';

if (import.meta.hot) {
  /**
   * 改 `defs.ts`：从新模块里取表。
   *
   * `config` 走 `{...}` 展开是必须的 —— `DEMO_CONFIG` 是 `readonly` 对象，
   * 直接引用新模块的引用会让 `ConfigHost` 里的旧表与新表共享同一份 config，
   * 于是「取消了热重载」这种诡异现象会出现（因为旧表也被改了）。
   */
  import.meta.hot.accept('./defs', (mod) => {
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
