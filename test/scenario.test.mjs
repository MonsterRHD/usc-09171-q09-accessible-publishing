import assert from "node:assert/strict";
import test from "node:test";
import { actors, buildAndDispatchAll, draftAndConfirmAll, newHarness, setupReadyObject } from "./helpers.mjs";

function displayed(channel, digest, receiptId, at) {
  return {
    receipt_id: receiptId,
    channel,
    package_digest: digest,
    status: "displayed",
    received_at: at,
    displayed_at: at,
  };
}

test("综合场景：事实变更与图片撤回后精确失效，语音延迟不被误判，公开端不再混淆", () => {
  const { clock, service } = newHarness("2026-09-12T10:00:00+08:00");

  // 原件与可触摸复制品分别建档。
  setupReadyObject(service, "bronze-ding", { kind: "original", imageIds: ["img-front"] });
  setupReadyObject(service, "ding-replica", { kind: "touch-replica", imageIds: [] });

  // 原件内容包投三渠道并全部展示。
  const first = buildAndDispatchAll(service, clock, "bronze-ding", {
    channels: ["touch-label", "miniapp", "audio-guide"],
  });
  clock.advance(60_000);
  for (const [channel, id] of [
    ["touch-label", "r-touch-1"],
    ["miniapp", "r-mini-1"],
    ["audio-guide", "r-audio-1"],
  ]) {
    service.recordReceipt(null, displayed(channel, first.digest, id, clock.iso()));
  }

  // 复制品内容只上触摸标签。
  const replicaPkg = buildAndDispatchAll(service, clock, "ding-replica", { channels: ["touch-label"] });
  clock.advance(60_000);
  service.recordReceipt(null, displayed("touch-label", replicaPkg.digest, "r-replica-1", clock.iso()));

  // 复制品描述不会污染原件：原件触摸标签当前展示仍为原件包。
  const originalOnTouch = service.resendScope(actors.editor, { objectId: "bronze-ding" });
  assert.equal(originalOnTouch.channels["touch-label"].displayedDigest, first.digest);

  // ---- 变更 1：跨渠道共用事实更新（撤回年代判断）----
  const beforeChange = clock.iso();
  clock.advance(60_000);
  service.retractFact(actors.curator, {
    objectId: "bronze-ding",
    version: "f1",
    reason: "年代判断已撤回",
  });
  service.recordFact(actors.curator, {
    objectId: "bronze-ding",
    body: { name: "青铜鼎", period: "西周早期", basis: "新测定" },
    changeNote: "更正年代",
  });
  draftAndConfirmAll(service, "bronze-ding", { suffix: "·更正版" });

  // ---- 变更 2：撤回图片许可 ----
  service.withdrawImageLicense(actors.copyright, {
    objectId: "bronze-ding",
    imageId: "img-front",
    reason: "授权到期撤回",
  });

  // 此时还没有任何重发：三渠道在展内容全部失效，原因分别可见。
  const stale = service.resendScope(actors.editor, { objectId: "bronze-ding" });
  for (const channel of ["touch-label", "miniapp", "audio-guide"]) {
    assert.equal(stale.channels[channel].status, "displayed-stale", channel);
    assert.equal(stale.channels[channel].needsResend, true, channel);
    assert.ok(stale.channels[channel].reasons.includes("核心事实已变化或被撤回"), channel);
  }
  // 图片撤回只影响携带该图片且授权覆盖的渠道；语音脚本渠道本就不含图片。
  assert.ok(stale.channels.miniapp.reasons.some((r) => r.includes("img-front")));
  assert.ok(!stale.channels["audio-guide"].reasons.some((r) => r.includes("img-front")));

  // 图片许可未恢复前，新包无法通过门禁。
  const blocked = service.buildPackage(actors.editor, { objectId: "bronze-ding" });
  assert.equal(blocked.digest, null);
  assert.ok(blocked.blocking.some((b) => b.scope === "image-license" && b.imageId === "img-front"));

  // 版权人员重新授权后门禁通过。
  service.grantImageLicense(actors.copyright, { objectId: "bronze-ding", imageId: "img-front" });
  const second = service.buildPackage(actors.editor, { objectId: "bronze-ding" });
  assert.equal(second.blocking.length, 0);
  assert.notEqual(second.digest, first.digest);

  // ---- 重发三渠道；语音渠道延迟，先只来 accepted ----
  const redispatched = service.dispatchPackage(actors.editor, {
    objectId: "bronze-ding",
    channels: ["touch-label", "miniapp", "audio-guide"],
    digest: second.digest,
  });
  clock.advance(30_000);
  service.recordReceipt(null, displayed("touch-label", second.digest, "r-touch-2", clock.iso()));
  clock.advance(30_000);
  service.recordReceipt(null, displayed("miniapp", second.digest, "r-mini-2", clock.iso()));
  clock.advance(30_000);
  service.recordReceipt(null, {
    receipt_id: "r-audio-2-acc",
    channel: "audio-guide",
    package_digest: second.digest,
    status: "accepted",
    received_at: clock.iso(),
    displayed_at: null,
  });

  const scope = service.resendScope(actors.editor, { objectId: "bronze-ding" });
  assert.equal(scope.channels["touch-label"].status, "displayed-current");
  assert.equal(scope.channels.miniapp.status, "displayed-current");
  // 语音旧版本仍在展、新版本已收到但未展示：标记为“重发在途”，不要求再次重发。
  assert.equal(scope.channels["audio-guide"].status, "resend-in-flight");
  assert.equal(scope.channels["audio-guide"].needsResend, false);
  assert.equal(scope.channels["audio-guide"].awaitingDisplay, true);
  assert.equal(scope.channels["audio-guide"].displayedDigest, first.digest);

  // 语音渠道最终展示，全线收敛。
  clock.advance(120_000);
  service.recordReceipt(null, displayed("audio-guide", second.digest, "r-audio-2", clock.iso()));
  const finalScope = service.resendScope(actors.editor, { objectId: "bronze-ding" });
  assert.equal(finalScope.channels["audio-guide"].status, "displayed-current");
  assert.equal(finalScope.channels["audio-guide"].displayedDigest, second.digest);

  // ---- 审计：还原任意时间点真正展示过的版本 ----
  // 变更前：三渠道展示的都是旧包。
  const oldAudio = service.displayAt(actors.coordinator, { channel: "audio-guide", at: beforeChange });
  assert.equal(oldAudio.displayed["bronze-ding"].digest, first.digest);
  assert.equal(oldAudio.displayed["bronze-ding"].factVersion, "f1");

  // 语音延迟窗口内：语音渠道真正对外的仍是旧版 f1（不能把“收到”当“展示”）。
  const duringDelay = service.displayAt(actors.coordinator, {
    channel: "audio-guide",
    at: "2026-09-12T10:03:31+08:00",
  });
  assert.equal(duringDelay.displayed["bronze-ding"].digest, first.digest);

  // 最终：语音渠道展示新包 f2。
  const nowAudio = service.displayAt(actors.coordinator, { channel: "audio-guide", at: clock.iso() });
  assert.equal(nowAudio.displayed["bronze-ding"].factVersion, "f2");
  assert.equal(nowAudio.displayed["bronze-ding"].digest, second.digest);

  // 历史时间点的触摸标签同时陈列原件与复制品，两者各自独立可还原。
  const touchThen = service.displayAt(actors.coordinator, { channel: "touch-label", at: beforeChange });
  assert.deepEqual(Object.keys(touchThen.displayed).sort(), ["bronze-ding", "ding-replica"]);

  // 复制品对象全程独立，原件的任何失效与重发都不影响它。
  const replicaScope = service.resendScope(actors.editor, { objectId: "ding-replica" });
  assert.equal(replicaScope.channels["touch-label"].status, "displayed-current");
});
