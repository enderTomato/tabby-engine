/**
 * `@tabby/gameplay` —— 参考玩法层。
 *
 * 这一层坐在引擎之内、应用之外：它认识经济内核、路网图、格子几何，
 * 但**不认识 Vue、不认识 Three、不认识 DOM**。
 *
 * 判据很简单：换一个玩法（塔防、工厂、卡牌）这些东西还要不要？
 * - 要 → 它该在引擎包里（`@tabby/economy` 之类）
 * - 不要，但换掉框架还要 → `@tabby/ui`
 * - 不要，而且换个玩法就重写 → 就在这里
 *
 * 所以这里放的是「城市建造」这个具体玩法的规则：住宅/农田/挡板三种建筑、
 * 灌溉收益折算、路网到市政厅的物流效率、配置表、分块地图存档。
 */

export * from './city.js';
export * from './defs.js';
export * from './config-table.js';
export * from './config-loader.js';
export * from './chunkstore.js';
export * from './logistics.js';
export * from './minimap-spec.js';
export * from './simulation.js';
export * from './knobs.js';
