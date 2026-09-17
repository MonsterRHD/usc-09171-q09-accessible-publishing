import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.mjs";
import { actors, buildAndDispatchAll, draftAndConfirmAll, newHarness, setupReadyObject } from "./helpers.mjs";

const assertForbidden = (fn) => {
  try {
    fn();
    assert.fail("应当拒绝");
  } catch (error) {
    assert.ok(error instanceof DomainError && error.status === 403);
  }
};

test("观众纠错：普通编辑看不到联系方式，未提供则不留存", () => {
  const { service } = newHarness();
  setupReadyObject(service, "o1", { imageIds: [] });

  const withContact = service.fileCorrection(null, {
    objectId: "o1",
    channels: ["miniapp"],
    description: "年代描述疑似有误",
    name: "王女士",
    contact: "wang@example.com",
  });
  service.fileCorrection(null, {
    objectId: "o1",
    description: "触摸标签与小程序说法不一致",
  });

  const listed = service.listCorrections(actors.editor);
  assert.equal(listed.length, 2);
  for (const item of listed) {
    assert.equal("name" in item, false);
    assert.equal("contact" in item, false);
  }
  const flagged = listed.find((c) => c.correctionId === withContact.correctionId);
  assert.equal(flagged.hasContact, true);

  // 普通编辑无权读取联系方式，协调员可以按需读取。
  assertForbidden(() =>
    service.readCorrectionContact(actors.editor, { correctionId: withContact.correctionId })
  );
  const contact = service.readCorrectionContact(actors.coordinator, {
    correctionId: withContact.correctionId,
  });
  assert.equal(contact.contact, "wang@example.com");

  const anonymous = listed.find((c) => c.description === "触摸标签与小程序说法不一致");
  const none = service.readCorrectionContact(actors.coordinator, { correctionId: anonymous.correctionId });
  assert.equal(none.contact, null);
});

test("紧急纠错：先撤下有害表述，办结必须补齐原因、替代版本、批准人", () => {
  const { clock, service } = newHarness();
  setupReadyObject(service, "o1");
  const first = buildAndDispatchAll(service, clock, "o1", { channels: ["miniapp", "audio-guide"] });
  for (const [channel, id] of [
    ["miniapp", "r-mini"],
    ["audio-guide", "r-audio"],
  ]) {
    service.recordReceipt(null, {
      receipt_id: id,
      channel,
      package_digest: first.digest,
      status: "displayed",
      received_at: "2026-09-12T11:00:03+08:00",
      displayed_at: "2026-09-12T11:00:20+08:00",
    });
  }

  const { correctionId } = service.emergencyPull(actors.editor, {
    objectId: "o1",
    channels: ["miniapp", "audio-guide"],
    harmfulDescription: "沿用已撤回年代判断",
  });
  let scope = service.resendScope(actors.editor, { objectId: "o1" });
  assert.equal(scope.channels.miniapp.status, "pulled");
  assert.equal(scope.channels["audio-guide"].status, "pulled");

  // 缺项不能办结。
  assert.throws(
    () =>
      service.resolveCorrection(actors.coordinator, {
        correctionId,
        reason: "事实已更正",
      }),
    /办结缺少必填项/
  );

  // 补齐：新事实 → 新组件 → 新包 → 新投递作为替代版本。
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "西周早期" } });
  draftAndConfirmAll(service, "o1", { suffix: "（更正）" });
  const replacement = buildAndDispatchAll(service, clock, "o1", {
    channels: ["miniapp", "audio-guide"],
  });
  const replacementDispatchId = service
    .listDispatches(actors.editor, { objectId: "o1" })
    .filter((d) => d.digest === replacement.digest && d.channel === "miniapp")[0].dispatchId;

  service.resolveCorrection(actors.coordinator, {
    correctionId,
    reason: "原年代判断已撤回，改用西周年限并经馆员重新确认",
    replacementDispatchId,
    approver: { id: "u-curator", role: "curator" },
  });

  const correction = service.listCorrections(actors.editor).find((c) => c.correctionId === correctionId);
  assert.equal(correction.status, "resolved");
  assert.equal(correction.resolution.approver.id, "u-curator");
  assert.equal(correction.resolution.replacementDispatchId, replacementDispatchId);
});
