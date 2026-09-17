import fs from "node:fs";
import { EventStore } from "./store.mjs";

// JSONL 持久化事件存储：进程重启后从日志重放，完整保留可审计的发布历史。
// 每条事件一行 JSON；追加采用同步写，单进程部署下顺序与崩溃一致性足够。
export class FileEventStore extends EventStore {
  constructor(path, options = {}) {
    super(options);
    this.path = path;
    this.#replay();
  }

  #replay() {
    if (!fs.existsSync(this.path)) return;
    const lines = fs.readFileSync(this.path, "utf8").split("\n").filter((line) => line.trim());
    for (const line of lines) {
      const event = JSON.parse(line);
      this.events.push(event);
      this.seq = Math.max(this.seq, event.seq);
    }
  }

  append(type, payload, actor) {
    const event = super.append(type, payload, actor);
    fs.appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    return event;
  }
}
