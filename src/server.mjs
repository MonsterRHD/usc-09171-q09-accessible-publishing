import { createServer } from "./app.mjs";
import { createClock } from "./domain/store.mjs";
import { FileEventStore } from "./domain/file-store.mjs";

// 设置 EVENT_LOG_PATH 后，发布事件持久化到 JSONL，重启不丢失审计历史。
const store = process.env.EVENT_LOG_PATH
  ? new FileEventStore(process.env.EVENT_LOG_PATH, { clock: createClock() })
  : undefined;

createServer({ store }).listen(Number(process.env.PORT ?? 8080));
