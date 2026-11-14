# Android 部署说明

本文只覆盖 **上 Android 之前必须改的那几件事**：跨域隔离头、Worker 打包、WebView 版本门槛、GPU 驱动降级。

## 1. 跨域隔离（SharedArrayBuffer 前提）

`SharedArrayBuffer` 不是"有就有"，它要求页面处于 cross-origin isolated 状态。缺头 → 引擎自动退到 `worker-copy`/`local`，功能不掉但 CPU 会上去。

Vite 的 `server` / `preview` 已内置头（见 `apps/demo/vite.config.ts`），只对本地开发有效。**生产必须自己配。**

### Nginx

```nginx
server {
  location / {
    root /var/www/tabby;
    add_header Cross-Origin-Opener-Policy   "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;

    # 带 hash 的静态资源可以长缓存
    location /assets/ {
      add_header Cache-Control "public, max-age=31536000, immutable";
    }
  }
}
```

`always` 不能省：4xx/5xx 响应缺头会让隔离状态翻转。

### 用了 CDN 的情况

`require-corp` 意味着 **所有跨域子资源都必须带 CORP 头或走 CORS**，否则会被拦。字体、图片、第三方 SDK 全都要检查：

```html
<img src="https://cdn.example.com/a.png" crossorigin="anonymous" />
```

或者对确实无法改头的域名改用 `require-corp` 的宽松版：

```nginx
add_header Cross-Origin-Embedder-Policy "credentialless" always;
```

`credentialless` 允许拉取不带凭据的跨域资源，代价是 cookie 不带。Chrome 支持良好，Safari 至今不支持 —— 所以 iOS 会掉到非隔离模式，这也符合"iOS 不专门优化但不破坏可运行性"的定位。

### Vercel / Netlify

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

### 验证

控制台执行 `crossOriginIsolated` 应为 `true`。引擎也会把它和 `host.mode` 一起打进诊断报告：

```ts
console.log(engine.getDiagnostics().report);
```

## 2. Capacitor 打包

WebView 里跑的是本地 `https://localhost` 或 `capacitor://localhost`，头由原生层下发。

```ts
// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.tabby',
  appName: 'Tabby Demo',
  webDir: 'dist',
  android: {
    // WebView 里 SAB 必须靠这两个头，Capacitor 默认不下发
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https', // 必须是 https，否则不是 secure context
  },
};
```

在 `android/app/src/main/java/.../MainActivity.java` 里给 WebView 挂钩子：

```java
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onStart() {
    super.onStart();
    WebView webView = getBridge().getWebView();
    // TWA/WebView 场景下的诊断开关，正式包记得去掉
    WebView.setWebContentsDebuggingEnabled(true);
  }
}
```

再通过 `bridge.getWebView().setWebViewClient(...)` 覆写 `shouldInterceptRequest` 注入响应头；更稳妥的做法是让 Capacitor 走 `capacitor.config` 的 `server.headers`（Capacitor 5+ 支持），或直接在 Service Worker 里补头。

**Service Worker 补头方案（推荐，跨容器通用）**：SW 拦截导航请求并重写响应头，TWA / WebView / 浏览器都吃同一套逻辑。注意 SW 本身也要求 https。

## 3. WebView 版本门槛

判 **WebView 版本，不判 Android 系统版本**。同一台 Android 8 手机可能装 WebView 68（2018）也可能装了 130+。

| 能力 | 最低 Chromium | 缺失时的降级 |
| --- | --- | --- |
| WebGL2 | 56 | 直接放弃渲染，给升级提示（不做 WebGL1 兼容） |
| module Worker | 80 | 退回 `worker-copy` 或主线程 |
| SharedArrayBuffer | 68（需隔离头） | `worker-copy` |
| OffscreenCanvas | 69 | 主线程渲染 |
| `??` / `?.` 等语法 | 80 | Vite `build.target` 已设 `es2022`，老内核直接语法报错 |

`es2022` 下 Chromium 80 以下会白屏 —— 这是有意的。低版本 WebView 的 GPU 驱动本身就撑不住 WebGL2 场景，与其做全量降级不如给明确提示。

在入口做前置拦截：

```ts
import { detectCapabilities } from '@tabby/platform';

const caps = detectCapabilities({ probeCanvas: canvas });
if (!caps.webgl2) {
  showUpgradeHint(); // 引导用户去 Play 商店更新 "Android System WebView"
  throw new Error('WebGL2 unavailable');
}
```

更新 WebView 的路径要写清楚（设置 → 应用 → Android System WebView → 更新），用户自己找不到。

## 4. GPU 驱动黑名单

`packages/platform/src/gpu-blacklist.ts` 按厂商 + 渲染器正则匹配，命中后只调整参数不阻断：

```ts
export interface GpuRule {
  readonly id: string;
  readonly family: GpuFamily;
  readonly test: RegExp;          // 匹配 UNMASKED_RENDERER_WEBGL
  readonly flags: Partial<GpuFlags>; // particleScale / disableMsaa / forceLocalPhysics
  readonly note: string;
}
```

新增规则时注意：

- 用 `UNMASKED_RENDERER_WEBGL` 全串匹配，别只匹配型号前缀（`Mali-G71` 和 `Mali-G710` 是两代完全不同的问题）
- 规则要带 `note`，线上出问题时 `engine.issues` 能直接说明为什么降级了
- 宁可多降一档也不要赌，`particleScale: 0.5` 只是少点视觉效果，崩驱动是整屏黑

已验证的典型问题：

| 家族 | 现象 | 处理 |
| --- | --- | --- |
| Mali-4xx | 高粒子数下驱动超时，渲染线程被杀 | `particleScale: 0.4` + 关 MSAA |
| PowerVR Rogue（老） | 浮点纹理采样精度崩坏，烟雾出现色块 | `particleScale: 0.5` + 关浮点渲染目标 |
| Adreno 5xx | 大 SAB 下偶发上下文丢失 | `forceLocalPhysics: true` |
| 部分 Mali-G 系 | MSAA + WebGL2 组合花屏 | `disableMsaa: true` |

## 5. 上线前必查

```ts
const caps = detectCapabilities({ probeCanvas: canvas });
console.log(caps.webView.chromiumMajor, caps.gpu.vendor, caps.gpu.renderer);
console.log(engine.getDiagnostics().report);
```

1. `crossOriginIsolated === true`，且 `engine.host.mode === 'worker-shared'`
2. 真机（不是模拟器）跑满 30 秒，`degrade` 事件不超过 1 次
3. 切后台再回前台，WebGL 上下文能恢复（`webglcontextlost` / `webglcontextrestored`）
4. 低端机上 `frame.cpuMs` 稳定在 12ms 以内，`drawCallsHint < 80`

## 6. 最可能踩的三个坑

1. **COOP/COEP 只配了 HTML 没配静态资源** —— 资源被拦后表现是"页面白屏但 200"，实际是 CORP 拦了 JS。用 DevTools Network 面板看 `net::ERR_BLOCKED_BY_RESPONSE`。
2. **把系统版本当门槛** —— Android 7 配新版 WebView 能跑得很好，Android 12 装了个一年没更新的 WebView 反而炸。永远看 `caps.webView.chromiumMajor`。
3. **WebView 里 `crossOriginIsolated` 恒为 false** —— Capacitor 默认不下发 COOP/COEP，SAB 静默退到 copy 模式，性能腰斩却不报错。上线前务必打日志确认 `host.mode`。
