import assert from "node:assert/strict";
import test from "node:test";
import { actors, buildAndDispatchAll, draftAndConfirmAll, newHarness, setupReadyObject } from "./helpers.mjs";

const displayReceipt = (channel, digest, id, { minutes = 1 } = {}) => ({
  receipt_id: id,
  channel,
  package_digest: digest,
  status: "displayed",
  received_at: new Date(Date.parse("2026-09-12T09:00:00+08:00") + minutes * 60000).toISOString(),
  displayed_at: new Date(Date.parse("2026-09-12T09:00:00+08:00") + minutes * 60000 + 5000).toISOString(),
});

test("accepted 不等于 displayed：语音渠道只回执 accepted 时不算公开展示", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest, dispatchIds } = buildAndDispatchAll(service, clock, "o1", {
    channels: ["miniapp", "audio-guide"],
  });

  service.recordReceipt(null, {
    receipt_id: "mini-accepted",
    channel: "miniapp",
    package_digest: digest,
    status: "accepted",
    received_at: "2026-09-12T11:00:03+08:00",
    displayed_at: null,
  });
  service.recordReceipt(null, {
    receipt_id: "audio-accepted",
    channel: "audio-guide",
    package_digest: digest,
    status: "accepted",
    received_at: "2026-09-12T11:01:44+08:00",
    displayed_at: null,
  });

  const scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels.miniapp.status, "in-flight");
  assert.equal(scope.channels["audio-guide"].status, "in-flight");
  assert.equal(scope.channels["audio-guide"].awaitingDisplay, true);
});

test("部分上线：小程序已展示、语音延迟，待重发范围如实反映", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest } = buildAndDispatchAll(service, clock, "o1", {
    channels: ["miniapp", "audio-guide"],
  });

  service.recordReceipt(null, displayReceipt("miniapp", digest, "mini-1", { minutes: 1 }));
  // 语音渠道延迟，仍只有 accepted。
  service.recordReceipt(null, {
    receipt_id: "audio-1",
    channel: "audio-guide",
    package_digest: digest,
    status: "accepted",
    received_at: "2026-09-12T11:01:44+08:00",
    displayed_at: null,
  });

  const scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels.miniapp.status, "displayed-current");
  assert.equal(scope.channels["audio-guide"].status, "in-flight");
  assert.equal(scope.channels["audio-guide"].awaitingDisplay, true);
});

test("同一回执重复投递幂等，不产生状态变化", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest } = buildAndDispatchAll(service, clock, "o1", { channels: ["miniapp"] });

  const receipt = displayReceipt("miniapp", digest, "mini-dup", { minutes: 1 });
  const first = service.recordReceipt(null, receipt);
  const second = service.recordReceipt(null, receipt);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);

  const timeline = service.channelTimeline(actors.editor, { channel: "miniapp" });
  assert.equal(timeline.filter((e) => e.kind === "displayed").length, 1);
  assert.equal(timeline.filter((e) => e.kind === "receipt-duplicate").length, 1);
});

test("渠道回执 failed 后记录并重试，成功展示", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest, dispatchIds } = buildAndDispatchAll(service, clock, "o1", {
    channels: ["audio-guide"],
  });
  const dispatchId = dispatchIds[0];

  service.recordReceipt(null, {
    receipt_id: "audio-fail",
    channel: "audio-guide",
    package_digest: digest,
    status: "failed",
    received_at: "2026-09-12T11:05:00+08:00",
    displayed_at: null,
  });
  let scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels["audio-guide"].status, "delivery-failed");
  assert.equal(scope.channels["audio-guide"].needsResend, true);

  service.retryDelivery(actors.editor, { dispatchId });
  scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels["audio-guide"].status, "in-flight");

  service.recordReceipt(null, displayReceipt("audio-guide", digest, "audio-ok", { minutes: 10 }));
  scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels["audio-guide"].status, "displayed-current");

  const dispatches = service.listDispatches(actors.editor, { objectId: "o1" });
  assert.equal(dispatches[0].attempts, 2);
  assert.deepEqual(dispatches[0].receipts, ["audio-fail", "audio-ok"]);
});

test("撤下后到达的旧“已展示”回执不能恢复展示", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest } = buildAndDispatchAll(service, clock, "o1", { channels: ["miniapp"] });
  service.recordReceipt(null, displayReceipt("miniapp", digest, "mini-1", { minutes: 1 }));

  // 撤下发生在首次展示之后。
  clock.set("2026-09-12T09:03:00+08:00");
  service.emergencyPull(actors.editor, {
    objectId: "o1",
    channels: ["miniapp"],
    harmfulDescription: "误导性表述",
  });
  // 渠道重复投递撤下前生成的旧回执。
  service.recordReceipt(null, displayReceipt("miniapp", digest, "mini-late", { minutes: 5 }));

  const scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels.miniapp.status, "pulled");
  assert.equal(scope.channels.miniapp.displayedDigest, null);
  const timeline = service.channelTimeline(actors.editor, { channel: "miniapp" });
  assert.equal(timeline.filter((e) => e.kind === "stale-display-after-pull").length, 1);
});

test("在途内容包（accepted 未展示）在事实变更后标记为失效，必须重发而非继续等待", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const { digest } = buildAndDispatchAll(service, clock, "o1", { channels: ["audio-guide"] });
  service.recordReceipt(null, {
    receipt_id: "audio-acc",
    channel: "audio-guide",
    package_digest: digest,
    status: "accepted",
    received_at: "2026-09-12T11:01:44+08:00",
    displayed_at: null,
  });

  // 事实撤回并更新，在途旧包作废。
  service.retractFact(actors.curator, { objectId: "o1", version: "f1", reason: "年代判断撤回" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "西周早期" } });

  const scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels["audio-guide"].status, "dispatch-invalidated");
  assert.equal(scope.channels["audio-guide"].needsResend, true);
  assert.ok(scope.channels["audio-guide"].reasons.includes("核心事实已变化或被撤回"));
});

test("新投递后，旧投递的迟到“已展示”回执不会回滚渠道", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const first = buildAndDispatchAll(service, clock, "o1", { channels: ["miniapp"] });
  // 旧包只 accepted，未展示。
  service.recordReceipt(null, {
    receipt_id: "mini-a1",
    channel: "miniapp",
    package_digest: first.digest,
    status: "accepted",
    received_at: "2026-09-12T11:00:03+08:00",
    displayed_at: null,
  });

  // 事实更新引发重新发布。
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "西周早期" } });
  draftAndConfirmAll(service, "o1", { suffix: "（修订）" });
  const second = buildAndDispatchAll(service, clock, "o1", { channels: ["miniapp"] });
  assert.notEqual(second.digest, first.digest);

  // 旧包迟到 displayed，不能覆盖；新包随后 displayed。
  service.recordReceipt(null, displayReceipt("miniapp", first.digest, "mini-old-late", { minutes: 3 }));
  const scopeBefore = service.resendScope(actors.editor, { objectId: "o1" });
  assert.notEqual(scopeBefore.channels.miniapp.displayedDigest, first.digest);

  service.recordReceipt(null, displayReceipt("miniapp", second.digest, "mini-new", { minutes: 4 }));
  const scopeAfter = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scopeAfter.channels.miniapp.status, "displayed-current");
  assert.equal(scopeAfter.channels.miniapp.displayedDigest, second.digest);
});
