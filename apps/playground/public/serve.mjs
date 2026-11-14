// Tabby Playground 静态服务器
// 用法：node serve.mjs [端口]   （端口优先级：命令行 > $PORT > 4180）
//
// 为什么不能直接双击 index.html：
// 1. file:// 下拿不到 WebGL2 上下文，12 个探针里有 4 个会直接失败
// 2. 解码器是 fetch 的相对路径，file:// 下会被 CORS 拦掉
// 3. SharedArrayBuffer 要求页面处于 cross-origin isolated 状态，
//    必须由服务端下发 COOP/COEP 头
//
// 发布到线上时由平台注入 $PORT，所以这里必须读环境变量、必须绑 0.0.0.0。
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  // KTX2 与 GLB 走二进制流；MIME 给错不会立刻报错，但会让浏览器的
  // 「另存为」和 CDN 压缩策略都做错事
  '.ktx2': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.map': 'application/json; charset=utf-8',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));

  try {
    if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // 单页应用：未知路径回落到 index.html
    filePath = join(ROOT, 'index.html');
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...ISOLATION_HEADERS });
    res.end('404 Not Found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const immutable = filePath.includes('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // 解码器文件名不带 hash，必须 no-cache —— 换 three 版本后旧缓存会一直命中
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...ISOLATION_HEADERS,
  });
  createReadStream(filePath).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Tabby Playground  ->  http://localhost:${PORT}/`);
  console.log('COOP/COEP 已下发，解码器与 SharedArrayBuffer 可用');
});
