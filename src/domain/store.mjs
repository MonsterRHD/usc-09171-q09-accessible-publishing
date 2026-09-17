// 可注入时钟：生产环境使用系统时间，测试中可精确推进，保证审计时间线确定。
export function createClock(start) {
  let now = start ? new Date(start).getTime() : Date.now();
  return {
    now: () => new Date(now),
    iso: () => new Date(now).toISOString(),
    advance(ms) {
      now += ms;
      return new Date(now);
    },
    set(at) {
      now = new Date(at).getTime();
    },
  };
}

// 仅追加的事件存储。所有状态变化都先成为事件，投影可以随时完整重放，
// 这是“审计人员还原任意时间点各渠道真正展示版本”的基础。
export class EventStore {
  constructor({ clock } = {}) {
    this.clock = clock ?? { now: () => new Date(), iso: () => new Date().toISOString() };
    this.events = [];
    this.seq = 0;
  }

  append(type, payload, actor) {
    const event = {
      seq: ++this.seq,
      type,
      at: this.clock.iso(),
      actor: actor ? { id: actor.id, role: actor.role } : null,
      payload,
    };
    this.events.push(event);
    return event;
  }

    all() {
    return this.events;
  }
}
