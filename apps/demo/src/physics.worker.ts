import { startFluidWorker, type WorkerScopeLike } from '@tabby/worker';

/**
 * 物理 Worker 入口。
 *
 * 放在业务侧（而不是由引擎包里 `new Worker(new URL(...))`）的原因：
 * Vite / webpack / Capacitor / TWA 对 worker 的打包规则各不相同，
 * 让宿主自己写这一行，引擎只提供 startFluidWorker 函数，打包器行为最可预期。
 */
startFluidWorker(self as unknown as WorkerScopeLike);
