import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEventStore } from "../src/domain/file-store.mjs";
import { createClock } from "../src/domain/store.mjs";
import { PublishingService } from "../src/domain/service.mjs";
import { actors, setupReadyObject } from "./helpers.mjs";

test("事件日志持久化：重启重放后对象、确认、投递与展示状态完整保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-events-"));
  const logPath = join(dir, "events.jsonl");
  try {
    const clock = createClock("2026-09-12T10:00:00+08:00");
    const store1 = new FileEventStore(logPath, { clock });
    const service1 = new PublishingService(store1);
    setupReadyObject(service1, "o1", { imageIds: ["img-1"] });
    const built = service1.buildPackage(actors.editor, { objectId: "o1" });
    service1.dispatchPackage(actors.editor, {
      objectId: "o1",
      channels: ["miniapp"],
      digest: built.digest,
    });
    service1.recordReceipt(null, {
      receipt_id: "r1",
      channel: "miniapp",
      package_digest: built.digest,
      status: "displayed",
      received_at: "2026-09-12T10:01:00+08:00",
      displayed_at: "2026-09-12T10:01:00+08:00",
    });

    // 模拟进程重启：从同一份日志重建服务。
    const store2 = new FileEventStore(logPath, { clock });
    const service2 = new PublishingService(store2);
    const scope = service2.resendScope(actors.editor, { objectId: "o1" });
    assert.equal(scope.channels.miniapp.status, "displayed-current");
    assert.equal(scope.channels.miniapp.displayedDigest, built.digest);

    // 历史时间点可在重启后继续还原。
    const then = service2.displayAt(actors.coordinator, {
      channel: "miniapp",
      at: "2026-09-12T10:01:00+08:00",
    });
    assert.equal(then.displayed.o1.factVersion, "f1");

    // 事件序号在重放后继续递增，不发生主键冲突。
    const next = service2.registerObject(actors.curator, {
      objectId: "o2",
      kind: "touch-replica",
      label: "o2",
    });
    assert.ok(next.seq > store1.seq);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
