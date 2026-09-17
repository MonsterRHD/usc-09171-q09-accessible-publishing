import assert from "node:assert/strict";
import test from "node:test";
import { setupObject, startApp } from "./helpers.mjs";

test("观众纠错只保留处理所需信息，普通编辑看不到联系方式", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, {})).body;

    // 超出处理所需范围的字段一律拒收
    const tooMuch = await app.request("POST", "/corrections", {
      body: { object_id: original.id, description: "年代标错了", id_card: "110101****" },
    });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, "field_not_allowed");

    const tooMuchContact = await app.request("POST", "/corrections", {
      body: {
        object_id: original.id,
        description: "年代标错了",
        contact: { email: "visitor@example.com", address: "某市某区" },
      },
    });
    assert.equal(tooMuchContact.status, 400);
    assert.equal(tooMuchContact.body.error.code, "contact_field_not_allowed");

    // 观众无需任何角色即可提交
    const created = await app.request("POST", "/corrections", {
      body: {
        object_id: original.id,
        channel: "miniapp",
        description: "小程序写的年代和语音导览不一致",
        contact: { name: "王观众", email: "visitor@example.com" },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.has_contact, true);
    assert.equal(created.body.contact, undefined);

    // 普通编辑的列表与详情都没有联系方式
    const list = await app.request("GET", "/corrections", { role: "editor" });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.ok(!("contact" in list.body[0]));
    assert.ok(!JSON.stringify(list.body).includes("visitor@example.com"));

    const contactAsEditor = await app.request("GET", `/corrections/${created.body.id}/contact`, {
      role: "editor",
    });
    assert.equal(contactAsEditor.status, 403);

    // 纠错处理人可以看到联系方式
    const contact = await app.request("GET", `/corrections/${created.body.id}/contact`, {
      role: "correction-handler",
    });
    assert.equal(contact.status, 200);
    assert.equal(contact.body.email, "visitor@example.com");

    // 审计日志中不出现联系方式
    assert.ok(!JSON.stringify(app.state.events).includes("visitor@example.com"));

    // 处理完成后联系方式被删除
    const resolved = await app.request("POST", `/corrections/${created.body.id}/resolve`, {
      role: "correction-handler",
      body: { resolution: "已更正年代并回复观众" },
    });
    assert.equal(resolved.body.status, "resolved");
    assert.equal(resolved.body.has_contact, false);

    const gone = await app.request("GET", `/corrections/${created.body.id}/contact`, {
      role: "correction-handler",
    });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, "contact_unavailable");
    assert.ok(!JSON.stringify(app.state).includes("visitor@example.com"));
  } finally {
    await app.close();
  }
});
