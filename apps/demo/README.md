# Tabby Demo

验证 Tabby Engine 全链路的最小可玩场景。构建产物在 `dist/`，**必须通过 HTTP 访问**。

## 跑起来

```bash
# 从仓库根目录
pnpm install
pnpm build

# 启动（dist 里自带 serve.mjs，会下发 COOP/COEP）
cd apps/demo/dist && node serve.mjs
# -> http://localhost:4173/
```

`serve.mjs` 带的头：

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

没有这两个头，`SharedArrayBuffer` 拿不到，引擎会静默退到 `worker-copy`。页面右上角面板的 `worker-shared` / `worker-copy` / `local` 就是当前实际模式。

直接双击 `index.html` 会白屏 —— `file://` 下没有 WebGL2 上下文。

## 玩法

**2D 经营**：网格上点选建筑放置。住宅提供人口，工厂消耗水产出金钱，农场需要水，公园提升满意度。底部工具栏有拆除。

**3D 试验场**：拖动旋转视角，滚轮缩放，点击地面丢一个布娃娃。上方水塔持续放水，风车摆锤受重力摆动，烟雾从工厂升起。

右上角 `诊断` 展开完整能力报告：GPU 厂商/渲染器、WebGL2 参数、Worker 与 SAB 支持、三档配置命中情况、降级原因。

## 控制台入口

```js
__tabby                     // Engine 实例
__tabby.tier                // 'low' | 'mid' | 'high'
__tabby.host.mode           // 'worker-shared' | 'worker-copy' | 'local'
__tabby.getDiagnostics()    // { report, fluid, ... }
__tabby3d.debug()           // { fluidPoints, smokePoints, ragdollVerts, drawCalls, triangles }
```

## 换档测试

```js
// 强制低端档，观察粒子数与分辨率变化
new Engine({ views: [...], forceTier: 'low' })
```
