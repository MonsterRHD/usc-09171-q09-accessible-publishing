import assert from "node:assert/strict";
import test from "node:test";
import { confirm, publishAndDispatch, setupObject, startApp } from "./helpers.mjs";

// 端到端场景：低视力观众反馈"触摸标签写可触摸复制品、小程序只写青铜器、
// 语音导览沿用已撤回的年代判断"。本测试走通完整治理流程：
// 对象分离 → 分域确认 → 多渠道发布 → 事实与授权变更 → 精确失效 → 修复重发 → 审计还原。
test("跨渠道无障碍语义发布全流程", async () => {
  const app = await startApp({ now: "2026-09-12T09:00:00+08:00" });
  try {
    // ---- 1. 对象：原件与复制品分离 ----
    const original = (await setupObject(app, { name: "兽面纹鼎" })).body;
    const replica = (
      await setupObject(app, { kind: "replica", name: "兽面纹鼎触摸复制品", replica_of: original.id })
    ).body;

    // ---- 2. 事实（跨渠道共用）与授权 ----
    const dating = (
      await app.request("POST", "/facts", {
        role: "curator",
        id: "curator-1",
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

    // ---- 3. 六类语义资产 ----
    const mk = async (objectId, kind, body, deps) =>
      (
        await app.request("POST", "/assets", {
          role: "editor",
          body: { object_id: objectId, kind, body, deps },
        })
      ).body;
    const term = await mk(original.id, "terminology", "青铜器", {
      facts: [{ fact_id: dating.id, version: 1 }],
    });
    const alt = await mk(original.id, "alt_text", "兽面纹鼎正面照片，立耳深腹", {
      facts: [{ fact_id: dating.id, version: 1 }],
      licenses: [license.id],
    });
    const easyRead = await mk(original.id, "easy_read", "这是一件三千多年前的青铜鼎", {
      facts: [{ fact_id: dating.id, version: 1 }],
    });
    const script = await mk(original.id, "audio_script", "这件鼎铸造于商代晚期", {
      facts: [{ fact_id: dating.id, version: 1 }],
    });
    const tactile = await mk(replica.id, "tactile_hint", "可触摸复制品，树脂材质，可触摸纹饰", {
      facts: [{ fact_id: replicaMaterial.id, version: 1 }],
    });

    // ---- 4. 分域确认：馆员、无障碍顾问、版权人员各认各的 ----
    await confirm(app, term.id, 1, "curatorial", "curator");
    await confirm(app, alt.id, 1, "accessibility", "accessibility");
    await confirm(app, easyRead.id, 1, "accessibility", "accessibility");
    await confirm(app, script.id, 1, "curatorial", "curator");
    await confirm(app, script.id, 1, "accessibility", "accessibility");
    await confirm(app, tactile.id, 1, "accessibility", "accessibility");

    // ---- 5. 发布到三个渠道 ----
    const pubOriginal = await publishAndDispatch(app, original.id, ["miniapp", "audio-guide"]);
    const pubReplica = await publishAndDispatch(app, replica.id, ["touch-label"]);
    assert.equal(pubOriginal.pub.status, 201);
    const digestA = pubOriginal.pub.body.digest;

    // 回执：小程序与触摸标签已展示；语音导览只确认收到（延迟展示）
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-mini-1",
        channel: "miniapp",
        package_digest: digestA,
        status: "displayed",
        received_at: "2026-09-12T10:00:00+08:00",
        displayed_at: "2026-09-12T10:00:30+08:00",
      },
    });
    await app.request("POST", "/channels/audio-guide/receipts", {
      body: {
        receipt_id: "r-audio-1",
        channel: "audio-guide",
        package_digest: digestA,
        status: "accepted",
        received_at: "2026-09-12T10:01:00+08:00",
        displayed_at: null,
      },
    });
    await app.request("POST", "/channels/touch-label/receipts", {
      body: {
        receipt_id: "r-touch-1",
        channel: "touch-label",
        package_digest: pubReplica.pub.body.digest,
        status: "displayed",
        received_at: "2026-09-12T10:02:00+08:00",
        displayed_at: "2026-09-12T10:02:30+08:00",
      },
    });

    // ---- 6. 公开端核验：三个渠道不再混用对象 ----
    const miniView = await app.request("GET", `/public/channels/miniapp/objects/${original.id}`);
    assert.equal(miniView.status, 200);
    assert.ok(miniView.body.items.some((i) => i.kind === "terminology" && i.body === "青铜器"));
    assert.ok(!JSON.stringify(miniView.body).includes("可触摸复制品"));

    const touchView = await app.request("GET", `/public/channels/touch-label/objects/${replica.id}`);
    assert.ok(touchView.body.items.some((i) => i.kind === "tactile_hint"));
    assert.ok(!JSON.stringify(touchView.body).includes("商代晚期"));

    // 语音导览只 accepted 未 displayed → 公开端查不到
    const audioView = await app.request("GET", `/public/channels/audio-guide/objects/${original.id}`);
    assert.equal(audioView.status, 404);

    // ---- 7. 核心事实与授权变化：年代更正 + 撤回图片许可；语音渠道回执延迟 ----
    app.setNow("2026-09-13T09:00:00+08:00");
    const datingV2 = await app.request("POST", `/facts/${dating.id}/versions`, {
      role: "curator",
      body: { value: "西周早期" },
    });
    assert.equal(datingV2.status, 201);
    await app.request("POST", `/licenses/${license.id}/withdraw`, { role: "copyright" });

    // ---- 8. 编辑获得精确的待重发范围 ----
    const scope = await app.request("GET", "/republish-scope", { role: "editor" });
    const byChannel = Object.fromEntries(scope.body.channels.map((c) => [c.channel, c]));
    assert.equal(byChannel.miniapp.action, "urgent_republish"); // 正在展示失效内容
    assert.equal(byChannel["audio-guide"].action, "replace_before_display"); // 已接收未展示，先替换
    assert.equal(byChannel["touch-label"], undefined); // 复制品内容不受影响

    // 公开端立即止血：替代文本（许可撤回）被扣下，语音脚本（事实过时）标记 stale
    const stopped = await app.request("GET", `/public/channels/miniapp/objects/${original.id}`);
    assert.ok(stopped.body.withheld.some((w) => w.asset_id === alt.id));
    assert.ok(stopped.body.items.find((i) => i.asset_id === script.id).stale);

    // ---- 9. 修复：新授权 + 新资产版本 + 重新确认 + 重发 ----
    const license2 = (
      await app.request("POST", "/licenses", { role: "copyright", body: { title: "展品摄影授权(新)" } })
    ).body;
    const bump = async (asset, body, deps) => {
      await app.request("POST", `/assets/${asset.id}/versions`, { role: "editor", body: { body, deps } });
    };
    await bump(term, "青铜器", { facts: [{ fact_id: dating.id, version: 2 }] });
    await bump(alt, "兽面纹鼎正面照片，立耳深腹", {
      facts: [{ fact_id: dating.id, version: 2 }],
      licenses: [license2.id],
    });
    await bump(easyRead, "这是一件约三千年前的青铜鼎", { facts: [{ fact_id: dating.id, version: 2 }] });
    await bump(script, "这件鼎铸造于西周早期", { facts: [{ fact_id: dating.id, version: 2 }] });

    await confirm(app, term.id, 2, "curatorial", "curator");
    await confirm(app, alt.id, 2, "accessibility", "accessibility");
    await confirm(app, easyRead.id, 2, "accessibility", "accessibility");
    await confirm(app, script.id, 2, "curatorial", "curator");
    await confirm(app, script.id, 2, "accessibility", "accessibility");

    const repub = await publishAndDispatch(app, original.id, ["miniapp", "audio-guide"]);
    const digestB = repub.pub.body.digest;
    assert.notEqual(digestB, digestA);

    // 语音渠道仍然延迟回执：先 accepted，后 displayed
    await app.request("POST", "/channels/miniapp/receipts", {
      body: {
        receipt_id: "r-mini-2",
        channel: "miniapp",
        package_digest: digestB,
        status: "displayed",
        received_at: "2026-09-13T10:00:00+08:00",
        displayed_at: "2026-09-13T10:00:30+08:00",
      },
    });
    await app.request("POST", "/channels/audio-guide/receipts", {
      body: {
        receipt_id: "r-audio-2",
        channel: "audio-guide",
        package_digest: digestB,
        status: "accepted",
        received_at: "2026-09-13T10:01:00+08:00",
        displayed_at: null,
      },
    });

    // 待重发范围清空（语音渠道的新包已接收且内容有效）
    const scopeAfter = await app.request("GET", "/republish-scope", { role: "editor" });
    assert.equal(scopeAfter.body.channels.length, 0);

    // ---- 10. 语音渠道延迟后的展示回执 ----
    app.setNow("2026-09-14T09:00:00+08:00");
    await app.request("POST", "/channels/audio-guide/receipts", {
      body: {
        receipt_id: "r-audio-3",
        channel: "audio-guide",
        package_digest: digestB,
        status: "displayed",
        received_at: "2026-09-13T10:01:00+08:00",
        displayed_at: "2026-09-14T08:30:00+08:00",
      },
    });

    // ---- 11. 公开内容不再混淆，且使用更正后的事实 ----
    const finalMini = await app.request("GET", `/public/channels/miniapp/objects/${original.id}`);
    assert.equal(finalMini.body.withheld.length, 0);
    assert.ok(!finalMini.body.items.some((i) => i.stale));
    const finalAudio = await app.request("GET", `/public/channels/audio-guide/objects/${original.id}`);
    assert.equal(finalAudio.status, 200);
    assert.ok(JSON.stringify(finalAudio.body).includes("西周早期"));
    assert.ok(!JSON.stringify(finalAudio.body).includes("商代晚期"));

    // ---- 12. 审计：还原任意时间点各渠道真正展示过的版本 ----
    const at = async (t) =>
      (await app.request("GET", `/audit/displayed?at=${encodeURIComponent(t)}`, { role: "auditor" })).body;

    // 变更前：小程序展示旧包，语音渠道什么都没展示过（只有 accepted）
    const before = await at("2026-09-12T12:00:00+08:00");
    const beforeMap = Object.fromEntries(before.displayed.map((d) => [d.channel, d]));
    assert.equal(beforeMap.miniapp.digest, digestA);
    assert.equal(beforeMap["audio-guide"], undefined);
    assert.equal(beforeMap["touch-label"].digest, pubReplica.pub.body.digest);

    // 变更后、语音展示前：小程序已是新包，语音渠道仍无展示
    const middle = await at("2026-09-13T12:00:00+08:00");
    const middleMap = Object.fromEntries(middle.displayed.map((d) => [d.channel, d]));
    assert.equal(middleMap.miniapp.digest, digestB);
    assert.equal(middleMap["audio-guide"], undefined);

    // 语音延迟展示之后
    const after = await at("2026-09-14T10:00:00+08:00");
    const afterMap = Object.fromEntries(after.displayed.map((d) => [d.channel, d]));
    assert.equal(afterMap["audio-guide"].digest, digestB);
    assert.equal(afterMap["audio-guide"].since, "2026-09-14T08:30:00+08:00");

    // ---- 13. 观众纠错闭环（呼应低视力观众的反馈） ----
    const correction = await app.request("POST", "/corrections", {
      body: {
        object_id: original.id,
        channel: "audio-guide",
        description: "语音导览的年代和标签不一致",
        contact: { email: "visitor@example.com" },
      },
    });
    assert.equal(correction.status, 201);
    const editorList = await app.request("GET", "/corrections", { role: "editor" });
    assert.ok(!JSON.stringify(editorList.body).includes("visitor@example.com"));
    await app.request("POST", `/corrections/${correction.body.id}/resolve`, {
      role: "correction-handler",
      body: { resolution: "年代已统一更正为西周早期并全渠道重发" },
    });
  } finally {
    await app.close();
  }
});
