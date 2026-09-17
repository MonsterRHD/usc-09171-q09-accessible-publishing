import assert from "node:assert/strict";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

async function setupPublished(app, body = "青铜器") {
  const objects = await app.request("GET", "/objects", { role: "editor" });
  const original = objects.body[0];
  const term = (
    await app.request("POST", "/assets", {
      role: "editor",
      body: { object_id: original.id, kind: "terminology", body },
    })
  ).body;
  await confirm(app, term.id, 1, "curatorial", "curator");
  return publishAndDispatch(app, original.id, ["miniapp"]);
}

test("审计可以还原任意时间点各渠道真正展示过的版本", async () => {
  const app = await startApp({ now: "2026-09-12T09:00:00+08:00" });
  try {
    await setupObject(app, {});
    const first = await setupPublished(app, "青铜器");
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-1",
        channel: "miniapp",
        package_digest: first.pub.body.digest,
        status: "displayed",
        received_at: "2026-09-12T10:00:00+08:00",
        displayed_at: "2026-09-12T10:05:00+08:00",
      },
    });

    // 第二版内容替换展示
    app.setNow("2026-09-12T10:30:00+08:00");
    const second = await setupPublished(app, "青铜礼器");
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-2",
        channel: "miniapp",
        package_digest: second.pub.body.digest,
        status: "displayed",
        received_at: "2026-09-12T11:00:00+08:00",
        displayed_at: "2026-09-12T11:05:00+08:00",
      },
    });

    const objectId = first.pub.body.object_id;
    const at = async (t) =>
      (await app.request("GET", `/audit/displayed?at=${encodeURIComponent(t)}`, { role: "auditor" })).body;

    // 展示前：什么都没有
    assert.equal((await at("2026-09-12T09:30:00+08:00")).displayed.length, 0);
    // 第一版展示期间
    const during1 = await at("2026-09-12T10:30:00+08:00");
    assert.equal(during1.displayed.length, 1);
    assert.equal(during1.displayed[0].digest, first.pub.body.digest);
    // 第二版展示期间
    const during2 = await at("2026-09-12T12:00:00+08:00");
    assert.equal(during2.displayed[0].digest, second.pub.body.digest);

    // 紧急撤下后，撤下时间点之后不再视为展示
    app.setNow("2026-09-12T12:30:00+08:00");
    await app.request("POST", "/emergency-takedowns", {
      role: "editor",
      body: { channel: "miniapp", object_id: objectId, reason: "有害表述" },
    });
    assert.equal((await at("2026-09-12T13:00:00+08:00")).displayed.length, 0);
    // 但撤下前的历史仍然可以还原
    assert.equal((await at("2026-09-12T12:00:00+08:00")).displayed[0].digest, second.pub.body.digest);

    // 单渠道时间线：两个完整区间
    const timeline = await app.request(
      "GET",
      `/audit/channels/miniapp/timeline?object_id=${objectId}`,
      { role: "auditor" },
    );
    const intervals = timeline.body.objects[0].intervals;
    assert.equal(intervals.length, 2);
    assert.equal(intervals[0].digest, first.pub.body.digest);
    assert.equal(intervals[0].until, "2026-09-12T11:05:00+08:00");
    assert.equal(intervals[1].digest, second.pub.body.digest);
    assert.equal(intervals[1].until, "2026-09-12T12:30:00+08:00");
    assert.equal(timeline.body.objects[0].current, null);
  } finally {
    await app.close();
  }
});

test("审计接口只对审计与管理员开放", async () => {
  const app = await startApp();
  try {
    const denied = await app.request("GET", "/audit/displayed", { role: "editor" });
    assert.equal(denied.status, 403);
    const allowed = await app.request("GET", "/audit/displayed", { role: "auditor" });
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});
