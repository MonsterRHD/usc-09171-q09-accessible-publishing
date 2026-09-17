import assert from "node:assert/strict";
import test from "node:test";
import { confirm, setupObject, startApp } from "./helpers.mjs";

async function setupOriginalWithFact(app) {
  const original = (await setupObject(app, {})).body;
  const fact = (
    await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: original.id, key: "年代", value: "商代晚期" },
    })
  ).body;
  return { original, fact };
}

test("各角色只能确认自己负责的域", async () => {
  const app = await startApp();
  try {
    const { original, fact } = await setupOriginalWithFact(app);
    const script = (
      await app.request("POST", "/assets", {
        role: "editor",
        body: {
          object_id: original.id,
          kind: "audio_script",
          body: "这件鼎铸造于商代晚期",
          deps: { facts: [{ fact_id: fact.id, version: 1 }] },
        },
      })
    ).body;

    // 无障碍顾问不能确认 curatorial 域
    const wrong = await confirm(app, script.id, 1, "curatorial", "accessibility");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, "domain_not_allowed");

    // 语音脚本需要 curatorial + accessibility 两个域
    assert.equal((await confirm(app, script.id, 1, "curatorial", "curator")).status, 201);
    assert.equal((await confirm(app, script.id, 1, "accessibility", "accessibility")).status, 201);

    // 重复确认同一域 → 冲突
    const dup = await confirm(app, script.id, 1, "curatorial", "curator");
    assert.equal(dup.status, 409);

    // 版权人员不能确认无障碍域
    const rights = await confirm(app, script.id, 1, "accessibility", "copyright");
    assert.equal(rights.status, 403);
  } finally {
    await app.close();
  }
});

test("确认齐全前不能发布；依赖变化后旧确认不再作数", async () => {
  const app = await startApp();
  try {
    const { original, fact } = await setupOriginalWithFact(app);
    const script = (
      await app.request("POST", "/assets", {
        role: "editor",
        body: {
          object_id: original.id,
          kind: "audio_script",
          body: "这件鼎铸造于商代晚期",
          deps: { facts: [{ fact_id: fact.id, version: 1 }] },
        },
      })
    ).body;

    // 只确认了一个域 → 不可发布
    await confirm(app, script.id, 1, "curatorial", "curator");
    const early = await app.request("POST", "/publications", {
      role: "editor",
      body: { object_id: original.id, channels: ["audio-guide"], kinds: ["audio_script"] },
    });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "nothing_cleared");

    await confirm(app, script.id, 1, "accessibility", "accessibility");
    const cleared = await app.request("POST", "/publications", {
      role: "editor",
      body: { object_id: original.id, channels: ["audio-guide"] },
    });
    assert.equal(cleared.status, 201);

    // 事实更新后，旧版本虽然确认过，但已 stale，不能再进入新内容包
    await app.request("POST", `/facts/${fact.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    const stale = await app.request("POST", "/publications", {
      role: "editor",
      body: { object_id: original.id, channels: ["audio-guide"], kinds: ["audio_script"] },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "nothing_cleared");

    // 资产详情能看到评估结果
    const view = await app.request("GET", `/assets/${script.id}`, { role: "editor" });
    assert.equal(view.body.versions[0].assessment.status, "stale");
  } finally {
    await app.close();
  }
});

test("新版本需要重新确认，旧版本的确认不会继承", async () => {
  const app = await startApp();
  try {
    const { original, fact } = await setupOriginalWithFact(app);
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

    const v2 = await app.request("POST", `/assets/${term.id}/versions`, {
      role: "editor",
      body: { body: "青铜礼器" },
    });
    assert.equal(v2.status, 201);

    const view = await app.request("GET", `/assets/${term.id}`, { role: "editor" });
    assert.equal(view.body.versions[1].assessment.status, "unconfirmed");
    assert.deepEqual(view.body.versions[1].assessment.missing_confirmations, ["curatorial"]);
  } finally {
    await app.close();
  }
});

test("图片资产必须绑定授权", async () => {
  const app = await startApp();
  try {
    const original = (await setupObject(app, {})).body;
    const noLicense = await app.request("POST", "/assets", {
      role: "editor",
      body: { object_id: original.id, kind: "image", body: { url: "https://example/img.png" } },
    });
    assert.equal(noLicense.status, 400);
    assert.equal(noLicense.body.error.code, "image_requires_license");

    const license = (
      await app.request("POST", "/licenses", { role: "copyright", body: { title: "摄影授权" } })
    ).body;
    const withLicense = await app.request("POST", "/assets", {
      role: "editor",
      body: {
        object_id: original.id,
        kind: "image",
        body: { url: "https://example/img.png" },
        deps: { licenses: [license.id] },
      },
    });
    assert.equal(withLicense.status, 201);
  } finally {
    await app.close();
  }
});
