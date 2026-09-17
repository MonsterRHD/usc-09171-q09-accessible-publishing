import assert from "node:assert/strict";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

// 搭建：原件（年代事实 + 术语 + 替代文本[依赖图片授权] + 语音脚本）发布到 miniapp 与 audio-guide，
// 复制品（触觉提示）发布到 touch-label。
async function setupMuseum(app) {
  const original = (await setupObject(app, { name: "兽面纹鼎" })).body;
  const replica = (
    await setupObject(app, { kind: "replica", name: "触摸复制品", replica_of: original.id })
  ).body;
  const dating = (
    await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: original.id, key: "年代", value: "商代晚期" },
    })
  ).body;
  const replicaMaterial = (
    await app.request("POST", "/facts", {
      role: "curator",
      body: { object_id: replica.id, key: "材质", value: "树脂" },
    })
  ).body;
  const license = (
    await app.request("POST", "/licenses", { role: "copyright", body: { title: "展品摄影授权" } })
  ).body;

  const mk = async (objectId, kind, body, deps) =>
    (
      await app.request("POST", "/assets", {
        role: "editor",
        body: { object_id: objectId, kind, body, deps },
      })
    ).body;

  const term = await mk(original.id, "terminology", "青铜器", { facts: [{ fact_id: dating.id, version: 1 }] });
  const alt = await mk(original.id, "alt_text", "鼎身正面照片", {
    facts: [{ fact_id: dating.id, version: 1 }],
    licenses: [license.id],
  });
  const script = await mk(original.id, "audio_script", "这件鼎铸造于商代晚期", {
    facts: [{ fact_id: dating.id, version: 1 }],
  });
  const tactile = await mk(replica.id, "tactile_hint", "可触摸复制品，树脂材质", {
    facts: [{ fact_id: replicaMaterial.id, version: 1 }],
  });

  await confirm(app, term.id, 1, "curatorial", "curator");
  await confirm(app, alt.id, 1, "accessibility", "accessibility");
  await confirm(app, script.id, 1, "curatorial", "curator");
  await confirm(app, script.id, 1, "accessibility", "accessibility");
  await confirm(app, tactile.id, 1, "accessibility", "accessibility");

  const pubOriginal = await publishAndDispatch(app, original.id, ["miniapp", "audio-guide"]);
  const pubReplica = await publishAndDispatch(app, replica.id, ["touch-label"]);

  // miniapp 与 touch-label 已展示；audio-guide 只回执 accepted（延迟展示）
  await app.request("POST", "/channels/miniapp/receipts", {
    body: {
      receipt_id: "r-mini",
      channel: "miniapp",
      package_digest: pubOriginal.pub.body.digest,
      status: "displayed",
      received_at: "2026-09-12T10:10:00+08:00",
      displayed_at: "2026-09-12T10:10:30+08:00",
    },
  });
  await app.request("POST", "/channels/audio-guide/receipts", {
    body: {
      receipt_id: "r-audio",
      channel: "audio-guide",
      package_digest: pubOriginal.pub.body.digest,
      status: "accepted",
      received_at: "2026-09-12T10:11:00+08:00",
      displayed_at: null,
    },
  });
  await app.request("POST", "/channels/touch-label/receipts", {
    body: {
      receipt_id: "r-touch",
      channel: "touch-label",
      package_digest: pubReplica.pub.body.digest,
      status: "displayed",
      received_at: "2026-09-12T10:12:00+08:00",
      displayed_at: "2026-09-12T10:12:30+08:00",
    },
  });
  return { original, replica, dating, license, term, alt, script, tactile, pubOriginal, pubReplica };
}

test("修改跨渠道共用事实时精确算出受影响渠道，复制品不受影响", async () => {
  const app = await startApp();
  try {
    const m = await setupMuseum(app);

    // 预演：如果撤回年代 v1，会影响哪些渠道内容
    const preview = await app.request("POST", "/impact/compute", {
      role: "curator",
      body: { fact_id: m.dating.id, version: 1 },
    });
    assert.equal(preview.status, 200);
    const affectedChannels = preview.body.affected_deliveries.map((d) => d.channel).sort();
    assert.deepEqual(affectedChannels, ["audio-guide", "miniapp"]);
    // 正在展示的标记准确
    const mini = preview.body.affected_deliveries.find((d) => d.channel === "miniapp");
    const audio = preview.body.affected_deliveries.find((d) => d.channel === "audio-guide");
    assert.equal(mini.currently_displayed, true);
    assert.equal(audio.currently_displayed, false);

    // 实际修改事实：新版本取代旧版本，响应里直接带回影响范围
    const updated = await app.request("POST", `/facts/${m.dating.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    assert.equal(updated.status, 201);
    const impactedAssets = updated.body.impact.affected_assets.map((a) => a.kind).sort();
    assert.deepEqual(impactedAssets, ["alt_text", "audio_script", "terminology"]);
    // 复制品的触觉提示不在影响范围内
    assert.ok(!updated.body.impact.affected_assets.some((a) => a.asset_id === m.tactile.id));
  } finally {
    await app.close();
  }
});

test("撤回图片许可使依赖内容失效，待重发范围精确到渠道与对象", async () => {
  const app = await startApp();
  try {
    const m = await setupMuseum(app);

    // 修改共用事实 + 撤回图片许可
    await app.request("POST", `/facts/${m.dating.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    const withdrawn = await app.request("POST", `/licenses/${m.license.id}/withdraw`, {
      role: "copyright",
    });
    assert.equal(withdrawn.status, 200);
    assert.ok(withdrawn.body.impact.affected_assets.some((a) => a.asset_id === m.alt.id));

    const scope = await app.request("GET", "/republish-scope", { role: "editor" });
    assert.equal(scope.status, 200);
    const byChannel = Object.fromEntries(scope.body.channels.map((c) => [c.channel, c]));

    // miniapp：正在展示的内容里有失效（授权撤回）与过时（事实更新）→ 紧急重发
    assert.equal(byChannel.miniapp.action, "urgent_republish");
    assert.ok(byChannel.miniapp.displayed_issues.invalid.some((i) => i.asset_id === m.alt.id));
    assert.ok(byChannel.miniapp.displayed_issues.stale.some((i) => i.asset_id === m.script.id));

    // audio-guide：已接收未展示 → 必须在展示前替换
    assert.equal(byChannel["audio-guide"].action, "replace_before_display");
    assert.equal(byChannel["audio-guide"].current_display, null);

    // touch-label（复制品）：完全不受影响，不出现在待重发范围
    assert.equal(byChannel["touch-label"], undefined);
  } finally {
    await app.close();
  }
});

test("公开端在依赖失效后立即不再输出有害条目", async () => {
  const app = await startApp();
  try {
    const m = await setupMuseum(app);

    const before = await app.request("GET", `/public/channels/miniapp/objects/${m.original.id}`);
    assert.equal(before.status, 200);
    assert.equal(before.body.withheld.length, 0);

    // 撤回图片授权 → 替代文本立即从公开端消失
    await app.request("POST", `/licenses/${m.license.id}/withdraw`, { role: "copyright" });
    const after = await app.request("GET", `/public/channels/miniapp/objects/${m.original.id}`);
    assert.equal(after.status, 200);
    assert.ok(after.body.withheld.some((w) => w.asset_id === m.alt.id));
    assert.ok(!after.body.items.some((i) => i.asset_id === m.alt.id));

    // 事实被取代 → 条目标记 stale 而非继续当作有效内容
    await app.request("POST", `/facts/${m.dating.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    const stale = await app.request("GET", `/public/channels/miniapp/objects/${m.original.id}`);
    const scriptItem = stale.body.items.find((i) => i.asset_id === m.script.id);
    assert.equal(scriptItem.stale, true);

    // 事实被撤回 → 依赖它的条目也立即被扣下；全部条目失效时公开端整体撤回
    await app.request("POST", `/facts/${m.dating.id}/withdraw`, {
      role: "curator",
      body: { version: 2 },
    });
    const withdrawn = await app.request("GET", `/public/channels/miniapp/objects/${m.original.id}`);
    assert.equal(withdrawn.status, 410);
    assert.equal(withdrawn.body.error.code, "content_withdrawn");
    assert.ok(withdrawn.body.error.details.withheld.some((w) => w.asset_id === m.script.id));
  } finally {
    await app.close();
  }
});
