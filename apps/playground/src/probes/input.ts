/**
 * 探针：输入手势与热区。
 *
 * 验三件在真机上最容易出错、在桌面上永远复现不了的事：
 *
 * 1. **44px 热区**：图标只有 24px 但要点得中。这里把「视觉框」和「可点框」
 *    同时画出来 —— 手指点在图标外 8px 的地方也必须命中，点不到就是 bug。
 * 2. **手势识别**：真 pointer 事件 → `InputSample` 流水 → `GestureRecognizer`。
 *    点、双击、长按、拖拽、捏合、旋转都走同一条路，事件流打在日志里。
 * 3. **惯性帧率无关**：同一个初速度，30fps 和 120fps 下松手后转过的角度必须一致。
 *    这条用两份 `OrbitDriver` 各跑一遍、对比最终角度，直接给出误差。
 *
 * ## 为什么这里不用 `InputManager`
 *
 * `InputManager` 会把事件绑到元素上并管生命周期 —— 在这类验证台里，
 * 我们想要**看得见**每个样本。所以这里自己做指针 → 样本的转换，
 * 只有那一步是 DOM 相关的，识别器本身完全不知道 DOM 存在。
 */

import { GestureRecognizer, OrbitDriver, hitTest, type GestureEvent, type HitArea, type InputSample } from '@tabby/input';
import { addButton, addRow, makeControls, makeOverlay } from './shared.js';
import { batchLine, timeBatch, type BenchResult, type Probe } from '../types.js';

/** 三个「图标按钮」，故意做成 24×24 —— 远小于 44。 */
const ICONS: readonly HitArea[] = [
  { id: 'build', x: 70, y: 90, width: 24, height: 24 },
  { id: 'road', x: 130, y: 90, width: 24, height: 24 },
  { id: 'delete', x: 190, y: 90, width: 24, height: 24 },
];

interface Trail {
  readonly id: number;
  readonly points: { x: number; y: number }[];
  readonly kind: InputSample['pointerType'];
}

export function createInputProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let recognizer: GestureRecognizer | null = null;
  let trails: Trail[] = [];
  let events: string[] = [];
  let lastHit: { id: string | null; x: number; y: number; t: number } | null = null;
  /** 捏合基准距离，双指手势时用来画那个半径圈。 */
  let pinchRadius = 0;
  let pinchCenter: { x: number; y: number } | null = null;
  let rowEvents: HTMLSpanElement | null = null;
  let rowHit: HTMLSpanElement | null = null;
  let rowPointers: HTMLSpanElement | null = null;
  let rowInertia: HTMLSpanElement | null = null;
  const inertias: number[] = [];

  const now = (): number => performance.now();

  function sample(event: PointerEvent, rect: DOMRect): InputSample {
    return {
      id: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      t: now(),
      pointerType: event.pointerType === 'mouse' ? 'mouse' : event.pointerType === 'pen' ? 'pen' : 'touch',
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  /**
   * 把手势事件转成一行可读文字。
   *
   * 低层的 `down/move/up` 故意不显示 —— 一次拖拽会刷满几十行，
   * 真正有价值的是语义事件。日志里只留用户「意图」层面的东西。
   */
  function describe(event: GestureEvent): string | null {
    switch (event.kind) {
      case 'down':
        return null;
      case 'move':
        return null;
      case 'up':
        return null;
      case 'cancel':
        return 'cancel（被系统打断）';
      case 'tap':
        return `tap (${event.data.x.toFixed(0)},${event.data.y.toFixed(0)})`;
      case 'doubletap':
        return `doubletap 间隔 ${event.data.interval.toFixed(0)}ms`;
      case 'longpress':
        return `longpress ${event.data.duration.toFixed(0)}ms`;
      case 'dragstart':
        return `dragstart (${event.data.startX.toFixed(0)},${event.data.startY.toFixed(0)})`;
      case 'drag':
        return null;
      case 'dragend':
        return `dragend 总位移 (${event.data.totalX.toFixed(0)},${event.data.totalY.toFixed(0)}) 速度 ${Math.hypot(event.data.vx, event.data.vy).toFixed(2)} px/ms`;
      case 'pinchstart':
        return `pinchstart 基准 ${event.data.distance.toFixed(0)}px`;
      case 'pinch':
        return `pinch ×${event.data.scale.toFixed(2)}`;
      case 'pinchend':
        return `pinchend 结束于 ×${event.data.scale.toFixed(2)}`;
      case 'rotate':
        return `rotate ${((event.data.delta * 180) / Math.PI).toFixed(1)}°`;
      case 'pan2':
        return `双指平移 Δ(${event.data.dx.toFixed(0)},${event.data.dy.toFixed(0)})`;
      case 'wheel':
        return `wheel (${event.data.deltaX.toFixed(0)},${event.data.deltaY.toFixed(0)})${event.data.zoomIntent ? ' 缩放意图' : ''}`;
      default:
        return null;
    }
  }

  function pushEvent(event: GestureEvent): void {
    const line = describe(event);
    if (line !== null) {
      events.unshift(line);
      if (events.length > 7) events.pop();
    }
    // 命中判定与手势识别是两条独立的路：识别器只给坐标，热区由这里查。
    // 这两件事刻意不耦合 —— 手势库不需要知道屏幕上有哪些按钮。
    if (event.kind === 'tap' || event.kind === 'longpress' || event.kind === 'doubletap') {
      const hit = hitTest(ICONS, event.data.x, event.data.y);
      lastHit = { id: hit?.id ?? null, x: event.data.x, y: event.data.y, t: now() };
    }
    if (rowEvents !== null) rowEvents.textContent = events[0] ?? '（还没有手势）';
    if (rowHit !== null) {
      rowHit.textContent = lastHit === null ? '—' : lastHit.id ?? '未命中';
      rowHit.style.color = lastHit?.id == null ? 'var(--bad)' : 'var(--good)';
    }
    if (rowPointers !== null) rowPointers.textContent = `${recognizer?.activePointers ?? 0}`;
  }

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 360) * dpr));
    g2d = canvas.getContext('2d');
  }

  return {
    id: 'input',
    title: '输入手势 / 热区',
    summary: '24px 图标必须点得中（44px 热区）、六类手势、惯性在 30fps 与 120fps 下角度一致',
    group: '交互',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      events = [];
      trails = [];
      lastHit = null;

      recognizer = new GestureRecognizer(pushEvent, { delayTapForDouble: false });

      const toSample = (event: PointerEvent): InputSample | null => {
        if (canvas === null) return null;
        return sample(event, canvas.getBoundingClientRect());
      };

      const onDown = (event: PointerEvent): void => {
        const s = toSample(event);
        if (s === null || recognizer === null) return;
        canvas?.setPointerCapture(event.pointerId);
        event.preventDefault();
        trails = trails.filter((trail) => trail.id !== s.id);
        trails.push({ id: s.id, points: [{ x: s.x, y: s.y }], kind: s.pointerType });
        recognizer.down(s);
      };
      const onMove = (event: PointerEvent): void => {
        const s = toSample(event);
        if (s === null || recognizer === null) return;
        const trail = trails.find((item) => item.id === s.id);
        if (trail !== undefined) {
          trail.points.push({ x: s.x, y: s.y });
          if (trail.points.length > 160) trail.points.shift();
        }
        recognizer.move(s);
        // 双指时才画捏合圈
        if (recognizer.activePointers === 2) {
          const [a, b] = trails;
          if (a !== undefined && b !== undefined && a.points.length > 0 && b.points.length > 0) {
            const pa = a.points[a.points.length - 1] as { x: number; y: number };
            const pb = b.points[b.points.length - 1] as { x: number; y: number };
            pinchRadius = Math.hypot(pb.x - pa.x, pb.y - pa.y) / 2;
            pinchCenter = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
          }
        }
      };
      const onUp = (event: PointerEvent): void => {
        const s = toSample(event);
        if (s === null || recognizer === null) return;
        if (canvas?.hasPointerCapture(event.pointerId) === true) canvas.releasePointerCapture(event.pointerId);
        recognizer.up(s);
        trails = trails.filter((trail) => trail.id !== s.id);
        if (recognizer.activePointers < 2) {
          pinchCenter = null;
          pinchRadius = 0;
        }
      };
      const onCancel = (event: PointerEvent): void => {
        const s = toSample(event);
        if (s === null || recognizer === null) return;
        recognizer.cancel(s);
        trails = trails.filter((trail) => trail.id !== s.id);
      };
      const onWheel = (event: WheelEvent): void => {
        event.preventDefault();
        // deltaMode 必须归一化：Firefox 按「行」报（×16），部分设备按「页」报（×100）。
        // 不折算的话同样的滚动量在不同浏览器上缩放速度差一个数量级。
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
        const rect = canvas?.getBoundingClientRect();
        recognizer?.wheel({
          deltaX: event.deltaX * unit,
          deltaY: event.deltaY * unit,
          zoomIntent: event.ctrlKey,
          x: rect === undefined ? 0 : event.clientX - rect.left,
          y: rect === undefined ? 0 : event.clientY - rect.top,
        });
      };
      const onContextMenu = (event: Event): void => event.preventDefault();

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onCancel);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContextMenu);

      const overlay = makeOverlay(context.host, '输入手势 / 热区');
      rowPointers = addRow(overlay, '活动指针');
      rowEvents = addRow(overlay, '最近手势');
      rowHit = addRow(overlay, '命中热区');
      rowInertia = addRow(overlay, '惯性 30/120fps');

      const controls = makeControls(context.host);
      addButton(controls, '清空日志', () => {
        events = [];
        lastHit = null;
        if (rowEvents !== null) rowEvents.textContent = '（还没有手势）';
        if (rowHit !== null) {
          rowHit.textContent = '—';
          rowHit.style.color = '';
        }
        context.log('日志已清空');
      });
      const inertiaBtn = addButton(controls, '测惯性一致性', () => {
        const result = measureInertia();
        inertias.push(result.deltaDeg);
        if (rowInertia !== null) {
          rowInertia.textContent = `Δ ${result.deltaDeg.toFixed(3)}°`;
          rowInertia.style.color = result.deltaDeg < 0.05 ? 'var(--good)' : 'var(--bad)';
        }
        context.log(
          `惯性：30fps 转 ${result.slowDeg.toFixed(3)}°，120fps 转 ${result.fastDeg.toFixed(3)}°，差 ${result.deltaDeg.toFixed(4)}°`,
        );
      });
      void inertiaBtn;

      context.log('在画布上试：点、双击、长按、拖、双指捏合/旋转');
      context.log('三个小图标（24px）的可点范围被扩到了 44px —— 虚线框内都算命中');
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
      recognizer = null;
      trails = [];
      pinchCenter = null;
      pinchRadius = 0;
    },

    tick(t) {
      if (canvas === null || g2d === null) return;
      // 长按判定靠外部时钟推进，不用 setTimeout（后台标签页会被节流成批量补发）
      recognizer?.tick(t);

      const ctx2d = g2d;
      const w = canvas.width;
      const h = canvas.height;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.fillStyle = '#06080d';
      ctx2d.fillRect(0, 0, w, h);

      // 用 CSS 像素坐标系画，省得每个坐标都乘 dpr
      ctx2d.scale(dpr, dpr);
      const cw = w / dpr;
      const ch = h / dpr;

      ctx2d.strokeStyle = 'rgba(110,199,255,0.06)';
      ctx2d.lineWidth = 1;
      for (let x = 0; x < cw; x += 40) {
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, ch);
        ctx2d.stroke();
      }
      for (let y = 0; y < ch; y += 40) {
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(cw, y);
        ctx2d.stroke();
      }

      // 图标：实线是视觉框，虚线是扩展后的可点框
      ctx2d.font = '11px ui-monospace, monospace';
      for (const icon of ICONS) {
        const expanded = { x: icon.x - 10, y: icon.y - 10, width: 44, height: 44 };
        ctx2d.strokeStyle = 'rgba(255,209,102,0.5)';
        ctx2d.setLineDash([4, 4]);
        ctx2d.strokeRect(expanded.x, expanded.y, expanded.width, expanded.height);
        ctx2d.setLineDash([]);
        ctx2d.fillStyle = 'rgba(110,199,255,0.16)';
        ctx2d.fillRect(icon.x, icon.y, icon.width, icon.height);
        ctx2d.strokeStyle = 'rgba(110,199,255,0.75)';
        ctx2d.strokeRect(icon.x, icon.y, icon.width, icon.height);
        ctx2d.fillStyle = 'rgba(200,220,240,0.7)';
        ctx2d.fillText(icon.id, icon.x, icon.y - 6);
      }

      // 轨迹
      for (const trail of trails) {
        if (trail.points.length < 2) {
          const only = trail.points[0];
          if (only === undefined) continue;
          ctx2d.beginPath();
          ctx2d.fillStyle = trail.kind === 'mouse' ? 'rgba(110,199,255,0.8)' : 'rgba(255,209,102,0.85)';
          ctx2d.arc(only.x, only.y, 9, 0, Math.PI * 2);
          ctx2d.fill();
          continue;
        }
        ctx2d.beginPath();
        ctx2d.strokeStyle = trail.kind === 'mouse' ? 'rgba(110,199,255,0.55)' : 'rgba(255,209,102,0.6)';
        ctx2d.lineWidth = 2;
        const first = trail.points[0] as { x: number; y: number };
        ctx2d.moveTo(first.x, first.y);
        for (let i = 1; i < trail.points.length; i += 1) {
          const point = trail.points[i] as { x: number; y: number };
          ctx2d.lineTo(point.x, point.y);
        }
        ctx2d.stroke();
        const head = trail.points[trail.points.length - 1] as { x: number; y: number };
        ctx2d.fillStyle = 'rgba(255,255,255,0.9)';
        ctx2d.beginPath();
        ctx2d.arc(head.x, head.y, 5, 0, Math.PI * 2);
        ctx2d.fill();
      }

      // 捏合圈
      if (pinchCenter !== null && pinchRadius > 0) {
        ctx2d.strokeStyle = 'rgba(126,231,135,0.55)';
        ctx2d.setLineDash([6, 6]);
        ctx2d.beginPath();
        ctx2d.arc(pinchCenter.x, pinchCenter.y, pinchRadius, 0, Math.PI * 2);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      }

      // 最近一次命中的落点：命中绿、未命中红
      if (lastHit !== null) {
        const age = now() - lastHit.t;
        const alpha = Math.max(0, 1 - age / 600);
        ctx2d.strokeStyle = lastHit.id === null ? `rgba(255,107,107,${alpha})` : `rgba(126,231,135,${alpha})`;
        ctx2d.lineWidth = 2;
        const radius = 6 + age / 90;
        ctx2d.beginPath();
        ctx2d.arc(lastHit.x, lastHit.y, radius, 0, Math.PI * 2);
        ctx2d.stroke();
      }

      if (rowPointers !== null) rowPointers.textContent = `${recognizer?.activePointers ?? 0}`;
    },

    bench(): BenchResult {
      // 1) 识别器吞吐：喂一段合成的「按下-移动-抬起」，量每次样本的处理成本。
      //    单次序列只有几微秒，低于时钟分辨率 —— 必须批量。
      //    回调里**不要**收集事件对象/字符串：那部分开销是探针自己的，会把 1µs 抬到 30µs。
      let events = 0;
      const rec = new GestureRecognizer(() => {
        events += 1;
      });
      const sequence = timeBatch((i) => {
        const id = 1;
        const t0 = i * 400;
        rec.down({ id, x: 40, y: 40, t: t0, pointerType: 'touch', pressure: 0.5 });
        for (let step = 0; step < 4; step += 1) {
          rec.move({ id, x: 40 + step * 3, y: 40 + step * 2, t: t0 + step * 16, pointerType: 'touch', pressure: 0.5 });
        }
        rec.up({ id, x: 52, y: 48, t: t0 + 64, pointerType: 'touch', pressure: 0 });
        rec.tick(t0 + 64);
      }, 2000);
      const perSequence = events / (2000 + 200);

      // 2) 命中测试：44px 扩展 + 优先级，一次调用要能扛住整块 HUD
      const many: HitArea[] = [];
      for (let i = 0; i < 324; i += 1) {
        many.push({ id: `hud-${i}`, x: (i % 18) * 44, y: Math.floor(i / 18) * 44, width: 24, height: 24, z: i % 3 });
      }
      let hits = 0;
      const hitTiming = timeBatch((i) => {
        const x = (i % 18) * 44 + 12 + ((i % 7) - 3) * 4;
        const y = Math.floor((i % 324) / 18) * 44 + 12;
        if (hitTest(many, x, y) !== null) hits += 1;
      }, 2000);
      // 批量计时会先跑 warmup 次，那部分也会累加进 hits —— 所以按实际调用次数折算命中率
      const attempts = 2000 + 200;

      const inertia = measureInertia();
      return {
        lines: [
          batchLine('手势处理', sequence.perCallUs, '一次 按下+4移动+抬起'),
          batchLine('热区命中', hitTiming.perCallUs, `324 个热区，命中 ${hits}/${attempts}（每次调用会为每个可扩展热区分配一个新对象，是热路径上的 GC 来源）`),
          { label: '识别事件', value: `${perSequence.toFixed(1)}/序列`, hint: `按下·4 次移动·拖拽·抬起，共 ${events} 个事件` },
          {
            label: '惯性一致性',
            value: `Δ ${inertia.deltaDeg.toFixed(4)}°`,
            hint: `30fps ${inertia.slowDeg.toFixed(2)}° / 120fps ${inertia.fastDeg.toFixed(2)}°`,
          },
        ],
      };
    },
  };
}

/**
 * 惯性帧率一致性。
 *
 * 同一初速度，一个按 30fps（33.3ms）步进、一个按 120fps（8.3ms）步进，
 * 跑满同样的时长，最终角度必须一致。
 *
 * ## 为什么窗口只取 400ms
 *
 * 内核在速度低于 `INERTIA_EPSILON` 时会直接归零（否则会拖一个永远收不掉的小尾巴）。
 * 这个截止点落在哪一帧，取决于步长 —— 30fps 一帧跨 33ms，120fps 只跨 8ms，
 * 于是「截止早一点还是晚一点」本身就有半帧的差异，量级约 0.3°。
 *
 * 那是**截止策略**的误差，不是积分误差。要验的是后者，所以窗口取 400ms：
 * 此时速度还没掉到阈值以下，两者都跑的是纯粹的指数积分，差异应当接近浮点噪声。
 */
function measureInertia(): { slowDeg: number; fastDeg: number; deltaDeg: number } {
  const run = (stepMs: number, totalMs: number): number => {
    const driver = new OrbitDriver({ theta: 0, phi: 1.1, distance: 20 });
    driver.release(1.8, 0); // 1.8 弧度/秒
    const started = driver.state.theta;
    // **必须按步数推进，不能 `while (elapsed < totalMs)`**：
    // 33.333×12 = 399.9996 < 400，会多跑一帧变成 433ms；而 8.333×48 = 399.99 只多一帧到 408ms。
    // 两个窗口一长一短，比出来的差异是「窗口不同」而不是「积分不准」。
    const steps = Math.round(totalMs / stepMs);
    for (let i = 0; i < steps; i += 1) driver.update(stepMs);
    return Math.abs(((driver.state.theta - started) * 180) / Math.PI);
  };
  const slowDeg = run(1000 / 30, 400);
  const fastDeg = run(1000 / 120, 400);
  return { slowDeg, fastDeg, deltaDeg: Math.abs(slowDeg - fastDeg) };
}
