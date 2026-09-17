import assert from "node:assert/strict";
import test from "node:test";
import { setupObject, startApp } from "./helpers.mjs";

test("原件与复制品是分离的对象，复制品必须关联原件", async () => {
  const app = await startApp();
  try {
    const original = await setupObject(app, { kind: "original", name: "兽面纹鼎" });
    assert.equal(original.status, 201);
    assert.equal(original.body.kind, "original");

    const orphan = await setupObject(app, { kind: "replica", name: "无源复制品" });
    assert.equal(orphan.status, 400);
    assert.equal(orphan.body.error.code, "replica_requires_original");

    const replica = await setupObject(app, {
      kind: "replica",
      name: "兽面纹鼎触摸复制品",
      replica_of: original.body.id,
    });
    assert.equal(replica.status, 201);
    assert.equal(replica.body.replica_of, original.body.id);
  } finally {
    await app.close();
  }
});

test("复制品的事实不能用于原件的内容，反之亦然", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, { name: "兽面纹鼎" })).body;
    const replica = (
      await setupObject(app, { kind: "replica", name: "触摸复制品", replica_of: original.id })
    ).body;

    const replicaFact = await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: replica.id, key: "材质", value: "树脂" },
    });
    assert.equal(replicaFact.status, 201);

    // 把复制品的事实绑到原件资产上 → 拒绝，防止复制品描述传播到原件
    const leak = await app.request("POST", "/assets", {
      role: "editor",
      body: {
        object_id: original.id,
        kind: "easy_read",
        body: "这是一件可以触摸的复制品",
        deps: { facts: [{ fact_id: replicaFact.body.id, version: 1 }] },
      },
    });
    assert.equal(leak.status, 400);
    assert.equal(leak.body.error.code, "cross_object_reference");

    // 同对象事实 → 允许
    const originalFact = await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: original.id, key: "年代", value: "商代晚期" },
    });
    const okAsset = await app.request("POST", "/assets", {
      role: "editor",
      body: {
        object_id: original.id,
        kind: "easy_read",
        body: "这是一件青铜鼎",
        deps: { facts: [{ fact_id: originalFact.body.id, version: 1 }] },
      },
    });
    assert.equal(okAsset.status, 201);
  } finally {
    await app.close();
  }
});

test("事实版本：新版本取代旧版本，撤回只针对当前版本", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, {})).body;
    const fact = (
      await app.request("POST", "/facts", {
        role: "curator",
        body: { object_id: original.id, key: "年代", value: "商代晚期" },
      })
    ).body;

    const v2 = await app.request("POST", `/facts/${fact.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version.version, 2);
    assert.equal(v2.body.fact.versions[0].status, "superseded");
    assert.equal(v2.body.fact.versions[1].status, "current");

    // 已被取代的版本不能再撤回
    const withdrawOld = await app.request("POST", `/facts/${fact.id}/withdraw`, {
      role: "curator",
      body: { version: 1 },
    });
    assert.equal(withdrawOld.status, 409);

    const withdrawCurrent = await app.request("POST", `/facts/${fact.id}/withdraw`, {
      role: "curator",
      body: { version: 2 },
    });
    assert.equal(withdrawCurrent.status, 200);
    assert.equal(withdrawCurrent.body.version.status, "withdrawn");

    const again = await app.request("POST", `/facts/${fact.id}/withdraw`, {
      role: "curator",
      body: { version: 2 },
    });
    assert.equal(again.status, 409);
  } finally {
    await app.close();
  }
});

test("非馆员角色不能创建对象与事实", async () => {
  const app = await startApp();
  try {
    const asEditor = await app.request("POST", "/objects", {
      role: "editor",
      body: { kind: "original", name: "鼎" },
    });
    assert.equal(asEditor.status, 403);
    const original = (await setupObject(app, {})).body;
    const factAsEditor = await app.request("POST", "/facts", {
      role: "editor",
      body: { object_id: original.id, key: "年代", value: "商代" },
    });
    assert.equal(factAsEditor.status, 403);
  } finally {
    await app.close();
  }
});
