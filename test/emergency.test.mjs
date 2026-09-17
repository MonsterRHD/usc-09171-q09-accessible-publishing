import assert from "node:assert/strict";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

async function setupDisplayed(app) {
  const original = (await setupObject(app, {})).body;
  const fact = (
    await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: original.id, key: "年代", value: "商代晚期" },
    })
  ).body;
  const easyRead = (
    await app.request("POST", "/assets", {
      role: "editor",
      body: {
        object_id: original.id,
        kind: "easy_read",
        body: "这是一件商代晚期的鼎",
        deps: { facts: [{ fact_id: fact.id, version: 1 }] },
      },
    })
  ).body;
  await confirm(app, easyRead.id, 1, "accessibility", "accessibility");
  const { pub } = await publishAndDispatch(app, original.id, ["miniapp"]);
  await app.request("POST", "/channels/miniapp/receipts", {
    body: {
      receipt_id: "r-1",
      channel: "miniapp",
      package_digest: pub.body.digest,
      status: "displayed",
      received_at: "2026-09-12T10:05:00+08:00",
      displayed_at: "2026-09-12T10:06:00+08:00",
    },
  });
  return { original, fact, easyRead, pub: pub.body };
}

test("紧急纠错：先撤下，后补齐原因、替代版本与批准人", async () => {
  const app = await startApp();
  try {
    const { original, fact, easyRead } = await setupDisplayed(app);

    // 时间推进到展示之后：发现易读说明沿用了已撤回的年代判断
    app.setNow("2026-09-12T10:30:00+08:00");
    await app.request("POST", `/facts/${fact.id}/withdraw`, { role: "curator", body: { version: 1 } });

    // 紧急撤下：不需要先凑齐原因和替代版本
    const takedown = await app.request("POST", "/emergency-takedowns", {
      role: "editor",
      id: "editor-1",
      body: { channel: "miniapp", object_id: original.id },
    });
    assert.equal(takedown.status, 201);
    assert.equal(takedown.body.status, "open");
    assert.deepEqual(takedown.body.missing_fields.sort(), [
      "approver",
      "reason",
      "replacement_publication_id",
    ]);

    // 公开端立即不可见
    const publicView = await app.request("GET", `/public/channels/miniapp/objects/${original.id}`);
    assert.equal(publicView.status, 404);

    // 未补齐的撤下出现在待办中
    const scope = await app.request("GET", "/republish-scope", { role: "editor" });
    assert.equal(scope.body.open_takedowns.length, 1);

    // 只补原因 → 仍然 open
    const partial = await app.request("PATCH", `/emergency-takedowns/${takedown.body.id}`, {
      role: "editor",
      body: { reason: "沿用了已撤回的年代判断" },
    });
    assert.equal(partial.body.status, "open");
    assert.deepEqual(partial.body.missing_fields.sort(), ["approver", "replacement_publication_id"]);

    // 准备替代版本：新事实 + 新易读说明 + 确认 + 发布
    const factV2 = (
      await app.request("POST", `/facts/${fact.id}/versions`, {
        role: "curator",
        body: { value: "西周早期" },
      })
    ).body;
    await app.request("POST", `/assets/${easyRead.id}/versions`, {
      role: "editor",
      body: {
        body: "这是一件西周早期的鼎",
        deps: { facts: [{ fact_id: fact.id, version: factV2.version.version }] },
      },
    });
    await confirm(app, easyRead.id, 2, "accessibility", "accessibility");
    const replacement = await publishAndDispatch(app, original.id, ["miniapp"]);

    // 替代版本不能是其他对象的内容包
    const other = (await setupObject(app, { name: "另一件展品" })).body;
    const wrongPub = (
      await app.request("POST", "/publications", {
        role: "editor",
        body: { object_id: other.id, channels: ["miniapp"] },
      })
    );
    assert.equal(wrongPub.status, 409); // 另一对象没有内容，顺便验证
    const mismatched = await app.request("PATCH", `/emergency-takedowns/${takedown.body.id}`, {
      role: "editor",
      body: { replacement_publication_id: "pub-999" },
    });
    assert.equal(mismatched.status, 400);

    // 补齐替代版本与批准人 → 关闭
    const closed = await app.request("PATCH", `/emergency-takedowns/${takedown.body.id}`, {
      role: "editor",
      body: { replacement_publication_id: replacement.pub.body.id, approver: "curator-1" },
    });
    assert.equal(closed.body.status, "closed");
    assert.deepEqual(closed.body.missing_fields, []);
    assert.ok(closed.body.backfilled_at);

    // 已关闭的撤下不能再改
    const again = await app.request("PATCH", `/emergency-takedowns/${takedown.body.id}`, {
      role: "editor",
      body: { reason: "改写原因" },
    });
    assert.equal(again.status, 409);

    // 替代包展示后公开端恢复
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-2",
        channel: "miniapp",
        package_digest: replacement.pub.body.digest,
        status: "displayed",
        received_at: "2026-09-12T11:00:00+08:00",
        displayed_at: "2026-09-12T11:01:00+08:00",
      },
    });
    const restored = await app.request("GET", `/public/channels/miniapp/objects/${original.id}`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.items[0].body, "这是一件西周早期的鼎");
  } finally {
    await app.close();
  }
});

test("没有正在展示的内容时不能紧急撤下", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, {})).body;
    const res = await app.request("POST", "/emergency-takedowns", {
      role: "editor",
      body: { channel: "miniapp", object_id: original.id },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "nothing_displayed");
  } finally {
    await app.close();
  }
});
