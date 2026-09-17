import assert from "node:assert/strict";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

async function setupClearedAsset(app) {
  const original = (await setupObject(app, {})).body;
  const fact = (
    await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: original.id, key: "年代", value: "商代晚期" },
    })
  ).body;
  const term = (
    await app.request("POST", "/assets", {
      role: "editor",
      body: {
        object_id: original.id,
        kind: "terminology",
        body: "青铜器",
        deps: { facts: [{ fact_id: fact.id, version: 1 }] },
      },
    })
  ).body;
  await confirm(app, term.id, 1, "curatorial", "curator");
  return { original, fact, term };
}

test("发布生成内容包摘要，逐渠道记录投递与部分上线结果", async () => {
  const app = await startApp();
  try {
    const { original } = await setupClearedAsset(app);
    const { pub, deliveries } = await publishAndDispatch(app, original.id, ["miniapp", "audio-guide"]);
    assert.equal(pub.status, 201);
    assert.match(pub.body.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(pub.body.channels.length, 2);

    // 同一内容包投递到两个渠道，摘要一致（与既有回执样例的约定兼容）
    const [mini, audio] = pub.body.channels;
    assert.equal(mini.digest, audio.digest);
    // 派发后等待渠道回执
    assert.equal(deliveries[0].body.status, "awaiting_receipt");
    assert.equal(deliveries[1].body.status, "awaiting_receipt");

    // 只有小程序展示 → 部分上线
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-mini-1",
        channel: "miniapp",
        package_digest: pub.body.digest,
        status: "displayed",
        received_at: "2026-09-12T10:01:00+08:00",
        displayed_at: "2026-09-12T10:01:30+08:00",
      },
    });
    const view = await app.request("GET", `/publications/${pub.body.id}`, { role: "editor" });
    assert.equal(view.body.partially_live, true);
    const byChannel = Object.fromEntries(view.body.channels.map((c) => [c.channel, c]));
    assert.equal(byChannel.miniapp.currently_displaying, true);
    assert.equal(byChannel["audio-guide"].currently_displaying, false);
  } finally {
    await app.close();
  }
});

test("投递失败被记录，可以重试", async () => {
  const app = await startApp();
  try {
    const { original } = await setupClearedAsset(app);
    const pub = (
      await app.request("POST", "/publications", {
        role: "editor",
        body: { object_id: original.id, channels: ["audio-guide"] },
      })
    ).body;
    const deliveryId = pub.channels[0].id;

    const failed = await app.request("POST", `/deliveries/${deliveryId}/attempts`, {
      role: "editor",
      body: { outcome: "failed", error: "渠道网关 503" },
    });
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.attempts, 1);
    assert.equal(failed.body.last_error, "渠道网关 503");

    const retry = await app.request("POST", `/deliveries/${deliveryId}/attempts`, {
      role: "editor",
      body: { outcome: "sent" },
    });
    assert.equal(retry.body.status, "awaiting_receipt");
    assert.equal(retry.body.attempts, 2);
    assert.equal(retry.body.history.length, 2);

    // 已发出的投递不能重复发出
    const again = await app.request("POST", `/deliveries/${deliveryId}/attempts`, {
      role: "editor",
      body: { outcome: "sent" },
    });
    assert.equal(again.status, 409);
  } finally {
    await app.close();
  }
});

test("重新发布会作废同一渠道上未落地的旧投递", async () => {
  const app = await startApp();
  try {
    const { original, term } = await setupClearedAsset(app);
    const first = (
      await app.request("POST", "/publications", {
        role: "editor",
        body: { object_id: original.id, channels: ["miniapp"] },
      })
    ).body;

    // 修改内容后重新发布
    await app.request("POST", `/assets/${term.id}/versions`, {
      role: "editor",
      body: { body: "青铜礼器" },
    });
    await confirm(app, term.id, 2, "curatorial", "curator");
    const second = (
      await app.request("POST", "/publications", {
        role: "editor",
        body: { object_id: original.id, channels: ["miniapp"] },
      })
    ).body;

    const oldDelivery = app.state.deliveries.get(first.channels[0].id);
    assert.equal(oldDelivery.status, "superseded");
    assert.equal(second.channels[0].status, "pending");
    assert.notEqual(second.digest, first.digest);
  } finally {
    await app.close();
  }
});

test("没有可发布内容时返回 409 并说明原因", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, {})).body;
    await app.request("POST", "/assets", {
      role: "editor",
      body: { object_id: original.id, kind: "terminology", body: "青铜器" },
    });
    const res = await app.request("POST", "/publications", {
      role: "editor",
      body: { object_id: original.id, channels: ["miniapp"] },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "nothing_cleared");
    assert.equal(res.body.error.details.skipped[0].reason, "no_cleared_version");
  } finally {
    await app.close();
  }
});
