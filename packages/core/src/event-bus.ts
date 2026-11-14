export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

interface Entry {
  readonly listeners: Set<(payload: never) => void>;
}

/**
 * 类型安全的事件总线。
 *
 * 设计取舍：用 Map 而非对象字面量存监听器，避免原型属性污染；
 * emit 时拷贝一份数组，允许监听器在回调里反注册（常见于一次性事件）。
 */
export class EventBus<Events extends object> {
  private readonly entries = new Map<keyof Events, Entry>();
  private readonly anyListeners = new Set<(type: keyof Events, payload: unknown) => void>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    let entry = this.entries.get(type);
    if (entry === undefined) {
      entry = { listeners: new Set() };
      this.entries.set(type, entry);
    }
    entry.listeners.add(listener as (payload: never) => void);
    return () => {
      entry.listeners.delete(listener as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** 用于诊断/日志聚合，payload 为 unknown，业务代码请优先用 on。 */
  onAny(listener: (type: keyof Events, payload: unknown) => void): Unsubscribe {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const entry = this.entries.get(type);
    if (entry !== undefined && entry.listeners.size > 0) {
      for (const listener of [...entry.listeners]) {
        (listener as Listener<Events[K]>)(payload);
      }
    }
    if (this.anyListeners.size > 0) {
      for (const listener of [...this.anyListeners]) {
        listener(type, payload);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.anyListeners.clear();
  }
}
