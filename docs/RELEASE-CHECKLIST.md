# 上线检查清单

按顺序过。每条都写清「怎么验」和「不通过会怎样」——
只列名字的清单没人会认真执行。

---

## A. 构建与体积

- [ ] `pnpm build` 全绿，无 TS 报错
      **验**：`pnpm build 2>&1 | tail -5`
      **不通过**：`noUncheckedIndexedAccess` 报错通常意味着某处 `arr[i]` 可能 undefined，
      在真机上就是随机崩。

- [ ] 主包 gzip < 400KB，首屏可交互 < 3s（4G）
      **验**：`ls -la apps/demo/dist/assets/*.js`，或 Lighthouse。
      **现状**：demo 主包 gzip ≈ 320KB（Three + Pixi 占大头）。

- [ ] 分包生效：`three` 与 `pixi` 不在首屏同步加载路径上
      **验**：Network 面板里 `WebGLRenderer-*.js` 应该只在进 3D 时出现。
      **不通过**：2D 用户白等 200KB。

- [ ] 生产构建 `sourcemap: false`，但保留 `dist/assets/*.js.map` 在 CI 产物里
      **验**：线上不能有 map，出问题要能从 CI 归档里恢复。

- [ ] 资源体积预算：纹理 < 8MB、音频 < 5MB、地形数据 < 5MB
      **验**：`du -sh public/*`

---

## B. 跨域隔离（最容易在部署时丢掉）

- [ ] 响应头含 `Cross-Origin-Opener-Policy: same-origin` 与
      `Cross-Origin-Embedder-Policy: require-corp`
      **验**：`curl -I https://<域名>/ | grep -i cross-origin`，或页面上
      `crossOriginIsolated === true`。
      **不通过**：`SharedArrayBuffer` 拿不到 → 物理退到 `worker-copy`，
      每帧多一次全量位置拷贝。诊断面板会显示 `worker-copy` 而不是 `worker-shared`。

- [ ] 所有跨域资源带 `crossorigin` 属性或 `Cross-Origin-Resource-Policy: cross-origin`
      **验**：COEP 生效后，没带 CORP 的第三方图片/字体/CDN 会被拦。
      **症状**：页面正常但某些图裂了、字体回退。

- [ ] `serve.mjs` / Nginx / Capacitor 三处的头保持一致
      **验**：见 `docs/ANDROID-DEPLOY.md` 的三份配置。

---

## C. 移动端适配

- [ ] `viewport` meta 含 `viewport-fit=cover`，安全区用 `env(safe-area-inset-*)`
      **不通过**：刘海屏上 HUD 被遮一半。

- [ ] `touch-action: none` 在画布上生效（由 `InputManager` 自动设置）
      **验**：安卓上单指拖动不滚动页面。
      **不通过**：拖到一半「松手」，轨道相机停在半路。

- [ ] 所有可点元素热区 ≥ 44×44 CSS 像素
      **验**：诊断面板里的热区清单；或 `HitArea.expandable` 默认 true。

- [ ] 双指缩放不触发浏览器整体缩放
      **验**：iOS Safari 上双指捏合，页面不动、相机缩放。
      **不通过**：需要 `touch-action` + `user-scalable=no`（后者有可访问性代价，慎用）。

- [ ] 横竖屏切换后画布尺寸正确
      **验**：iOS 旋转时 `ResizeObserver` 可能晚一帧触发，必须走 `engine.resize()`。
      **不通过**：画面拉伸或只渲染左下角。

- [ ] 切后台 > 30s 回来不跳帧爆炸
      **验**：`TickScheduler` 的 `maxBacklogTicks`（240）会把超出的部分「推进日期但不结算」，
      并发 `tick-skipped` 事件。
      **不通过**：回来一瞬间跑几百天，直接破产。

---

## D. 性能（在最低目标机型上测，不是在开发机上）

- [ ] 主线程 CPU ≤ 8ms/帧（诊断面板 `CPU x.xms`）
- [ ] DrawCall < 150（`drawCallsHint`）
- [ ] 内存 < 300MB（`performance.memory` 或 Chrome DevTools）
- [ ] 无 GC 抖动：连续跑 5 分钟，帧时间 P99 不超过 P50 的 2 倍
      **验**：Performance 面板录 30s，看是否有锯齿状 GC。
      **不通过**：多半是热路径里有 `new`（每帧分配）。物理包里所有临时缓冲都是类字段复用。
- [ ] 低端档（`tier: low`）在目标机型上 ≥ 30fps
      **验**：`Engine.create({ forceTier: 'low' })`，或用 SwiftShader 模拟。
- [ ] 物体数达到设计上限时仍达标：布娃娃 36 个 / 流体粒子按档位 / 建筑 200 栋

---

## E. 稳定性

- [ ] WebGL context lost / restored 能恢复
      **验**：`canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()`。
      **不通过**：切后台久了回来黑屏，只能刷新。
- [ ] `pointercancel`（侧滑返回、通知栏下拉）不会误触发点击
      **验**：`InputManager` 的 `cancel` 分支不发 tap。
- [ ] 存档/读档往返一致：存 → 读 → 存，两次字节相同
      **验**：`k1 = eco.save(); eco.load(k1); k2 = eco.save(); assert.deepEqual(k1,k2)`。
- [ ] 存档损坏不静默变空地图：分块 CRC 校验失败必须报错
      **验**：截断存档末尾 2 字节再读。
- [ ] 读档后投影与实体池一致
      **验**：`__tabby3d.projection()` 返回 `ok: true`。
      **不通过**：说明有人绕过指令队列改了 `Economy.state`。
- [ ] 长时间运行 30 分钟无内存增长（缓存有上限：`maxCachedSources` 32、
      `maxVisible` 64、`buildingCapacity` 自动扩容但有界）

---

## F. 能力降级

- [ ] 无 WebGL2 → 不崩，给出可读提示（demo 实测：headless 无 GL 时
      `[tabby/engine] 视图 render3d 初始化失败，已跳过`）
- [ ] 无 SharedArrayBuffer → 退 `worker-copy` 并显示在诊断里
- [ ] 无 `navigator.vibrate`（iOS）→ 所有震动调用返回 false，UI 退回纯视觉反馈
- [ ] 软渲染（SwiftShader）→ 命中 GPU 黑名单，强制 `low` 档
      **验**：Xvfb + `--use-angle=swiftshader` 下诊断面板显示
      `GPU 规则: swiftshader`、`档位 low score=0`
- [ ] 没有 `localStorage`（隐私模式）→ 存档失败给出提示而不是抛错

---

## G. 可访问性与输入兜底

- [ ] 键盘：方向和 Tab 能操作全部按钮（工具栏、速度、存档）
- [ ] 焦点可见：`:focus-visible` 有描边，不能只有 hover 样式
- [ ] 色盲友好：状态不只靠颜色区分（断供同时有文字「断供」）
- [ ] 降低动效：`prefers-reduced-motion` 时关闭 GSAP 入场动画与惯性
- [ ] 字号：诊断面板 11px 在 320px 宽屏上不换行错位

---

## H. 观测

- [ ] 诊断面板能一键复制（`__tabby.getDiagnostics()` 返回完整报告）
- [ ] 关键计数上报：`tier` / `host.mode` / `fps` P50 / `cpu` P50 / 降级原因
- [ ] 异常有上下文：`pluginError` / `warning` 事件带 code，而不是只有字符串
- [ ] 版本号可查：`package.json` 的 version 进产物（`__TABBY_VERSION__`）

---

## I. 发布

- [ ] `LICENSING.md` 与实际 `package.json` 的 `license` 字段一致
      （核心 MPL-2.0、demo MIT；`packages/render2d|render3d` 目前是 MIT，
      因为它们是 Three/Pixi 的薄适配层，改 MPL 会把上游用户绊住）
- [ ] `pnpm pack:check` 每个包的 `files` 字段只含 `dist` + `README`
- [ ] 各包 `exports` 与 `types` 指到构建产物，`import` 而不是 `require`
- [ ] `physics` 的 API 快照已更新并提交（`etc/api-surface.md`）
- [ ] CHANGELOG 写明破坏性变更
