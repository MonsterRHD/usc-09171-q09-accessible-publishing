import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

const fixture = JSON.parse(await readFile(new URL("../contracts/channel-receipts.json", import.meta.url), "utf8"));

test("既有回执样例可以被接收：accepted 不等于 displayed", async () => {
  const app = await startApp();
  try {
    for (const receipt of fixture) {
      const res = await app.request("POST", `/channels/${receipt.channel}/receipts`, { body: receipt });
      assert.equal(res.status, 201);
      // 样例中的摘要没有对应投递，记录为未匹配而不是报错
      assert.equal(res.body.matched, false);
    }
    assert.equal(app.state.receipts.size, 2);

    const accepted = app.state.receipts.get("audio-331");
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.displayed_at, null);
  } finally {
    await app.close();
  }
});

test("同一回执重复投递是幂等的", async () => {
  const app = await startApp();
  try {
    const receipt = fixture[0];
    const first = await app.request("POST", `/channels/${receipt.channel}/receipts`, { body: receipt });
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicate, false);

    const second = await app.request("POST", `/channels/${receipt.channel}/receipts`, { body: receipt });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(app.state.receipts.size, 1);

    // 相同 receipt_id 但内容不同 → 冲突
    const conflict = await app.request("POST", `/channels/${receipt.channel}/receipts`, {
      body: { ...receipt, status: "accepted", displayed_at: null },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "receipt_conflict");
  } finally {
    await app.close();
  }
});

test("displayed 状态必须携带 displayed_at，accepted 不得携带", async () => {
  const app = await startApp();
  try {
    const noTime = await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-1",
        channel: "miniapp",
        package_digest: "sha256:x",
        status: "displayed",
        received_at: "2026-09-12T11:00:00+08:00",
        displayed_at: null,
      },
    });
    assert.equal(noTime.status, 400);
    assert.equal(noTime.body.error.code, "displayed_requires_time");

    const acceptedWithTime = await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-2",
        channel: "miniapp",
        package_digest: "sha256:x",
        status: "accepted",
        received_at: "2026-09-12T11:00:00+08:00",
        displayed_at: "2026-09-12T11:00:30+08:00",
      },
    });
    assert.equal(acceptedWithTime.status, 400);
    assert.equal(acceptedWithTime.body.error.code, "accepted_must_not_display");
  } finally {
    await app.close();
  }
});

test("回执驱动投递状态：accepted → displayed，重复 displayed 不重复计时", async () => {
  const app = await startApp();
  try {
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
    const { pub } = await publishAndDispatch(app, original.id, ["miniapp"]);
    const digest = pub.body.digest;

    const accepted = await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-a",
        channel: "miniapp",
        package_digest: digest,
        status: "accepted",
        received_at: "2026-09-12T10:05:00+08:00",
        displayed_at: null,
      },
    });
    assert.equal(accepted.body.matched, true);
    assert.equal(app.state.deliveries.get(pub.body.channels[0].id).status, "accepted");

    const displayed = await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-b",
        channel: "miniapp",
        package_digest: digest,
        status: "displayed",
        received_at: "2026-09-12T10:05:00+08:00",
        displayed_at: "2026-09-12T10:06:00+08:00",
      },
    });
    assert.equal(displayed.status, 201);
    const delivery = app.state.deliveries.get(pub.body.channels[0].id);
    assert.equal(delivery.status, "displayed");
    assert.equal(delivery.displayed_at, "2026-09-12T10:06:00+08:00");

    // 重复投递同一 displayed 回执 → 幂等，不产生新的展示事件
    const eventsBefore = app.state.events.filter((e) => e.type === "delivery_displayed").length;
    const dup = await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-b",
        channel: "miniapp",
        package_digest: digest,
        status: "displayed",
        received_at: "2026-09-12T10:05:00+08:00",
        displayed_at: "2026-09-12T10:06:00+08:00",
      },
    });
    assert.equal(dup.body.duplicate, true);
    const eventsAfter = app.state.events.filter((e) => e.type === "delivery_displayed").length;
    assert.equal(eventsBefore, eventsAfter);
  } finally {
    await app.close();
  }
});

test("回执 channel 必须与路径一致", async () => {
  const app = await startApp();
  try {
    const res = await app.request("POST", "/channels/miniapp/receipts", {
      body: { ...fixture[0], channel: "audio-guide" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "channel_mismatch");
  } finally {
    await app.close();
  }
});
