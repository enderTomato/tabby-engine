# ADR-003 · 线程模型

- **状态**：Accepted
- **日期**：2026-11-14
- **影响范围**：`packages/worker`、`packages/engine`；任务 T09 T12 T14

## 背景

液体是唯一在每帧产生大块数值数据的模块：1500 个粒子 × 3 个 float = 18KB/帧，60fps 就是 1MB/s。如果放在主线程算，低端机直接吃掉 6-8ms，把预算用光。

必须搬走，但 Android WebView 的碎片化让"搬走"本身有多种可能结果：

- 新 WebView（Chromium 88+）且配了 COOP/COEP → `SharedArrayBuffer` 可用，零拷贝
- 老 WebView 或没配头 → SAB 不可用，只能靠 `postMessage` 拷贝
- module Worker 不支持（Chromium < 80）→ 连 Worker 都起不来

## 可选方案

| 方案 | 优点 | 缺点 | 适用条件 |
|---|---|---|---|
| A. 主线程内联 | 零通信成本，调试方便 | 吃掉 6-8ms 预算，低端机必卡 | 兜底 |
| B. Worker + postMessage 拷贝 | 兼容性最好 | 每帧 18KB 结构化克隆，主线程仍有 1-2ms 开销 | 无 SAB |
| C. Worker + SAB 双缓冲 + 锁 | 零拷贝 | 主线程等锁会被阻塞，反而掉帧 | 不推荐 |
| D. **Worker + SAB + seqlock 无锁读** | 零拷贝零阻塞；读失败沿用上一帧，永不卡主线程 | 需要两端配合维护版本号 | SAB 可用 |

## 决策

**三档降级链，运行时自动选择，上层 API 完全一致：**

```
worker-shared  →  worker-copy  →  local
   (SAB)         (postMessage)   (主线程)
```

选择逻辑在 `createFluidHost()`，判定依据是 `caps.sharedArrayBuffer && caps.moduleWorker`，不判断平台。

**同步用 seqlock 而不是 mutex**：

- 写端（Worker）步进开始 `Atomics.add(seq, 1)` 变奇数，结束再 +1 变偶数
- 读端（主线程）读两次 seq，相等且为偶数才采用这帧数据，否则沿用上一帧
- 代价：两次 `Atomics.load`（约几十纳秒）
- 收益：**主线程永远不会被阻塞**。物理掉一帧无所谓，渲染掉一帧就是卡顿

## 后果

### 正面

- 业务代码不感知线程模型，`engine.host.mode` 只用于诊断面板
- 低端机即使没有 SAB 也能跑，只是 CPU 高一点
- 主线程读永远成功（最坏情况是读到旧数据），没有"等锁"这种可能

### 负面

- 主线程可能读到 1 帧旧数据，视觉上有 16ms 延迟。对液体这种慢变效果无感，但不能用于需要精确同步的场景
- 三套实现意味着三倍的通信代码要维护，但 API 只有一个，出问题只会在 host 层
- SAB 队列长度固定，粒子数超过 capacity 只能丢弃，不能扩容

## 风险与缓解

| 风险 | 触发条件 | 缓解措施 |
|---|---|---|
| COOP/COEP 没配好，SAB 静默不可用 | 生产部署漏配头 | 启动时打日志 + 诊断面板显示 `host.mode`；部署文档单列一节 |
| 跨域资源被 COEP 拦截 | 用了 CDN 字体/图片 | `docs/ANDROID-DEPLOY.md` 记录了 `credentialless` 回退方案 |
| WebView 里 SAB 恒不可用 | Capacitor 默认不下发头 | 诊断面板暴露 `crossOriginIsolated`，上线前必查 |
| Worker 里 `Atomics.wait` 死锁 | 误用阻塞原语 | 规范禁止在 Worker 里用 `Atomics.wait` 等主线程，只允许主线程 seqlock 轮询 |

## 相关

- 代码：`packages/worker/src/{shared-buffer,worker-entry,hosts,protocol}.ts`
- 部署：`docs/ANDROID-DEPLOY.md` §1
- 任务：T09 T12 T14
