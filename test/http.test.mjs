import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "../src/app.mjs";
import { COMPONENT_TYPES, ROLES } from "../src/domain/roles.mjs";

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonRequest = async (base, method, path, body, actor) => {
  const headers = { "content-type": "application/json" };
  if (actor) {
    headers["x-actor-id"] = actor.id;
    headers["x-actor-role"] = actor.role;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
};

const curator = { id: "u-curator", role: ROLES.CURATOR };
const a11y = { id: "u-a11y", role: ROLES.ACCESSIBILITY };
const copyright = { id: "u-copyright", role: ROLES.COPYRIGHT };
const editor = { id: "u-editor", role: ROLES.EDITOR };
const coordinator = { id: "u-coord", role: ROLES.COORDINATOR };

test("HTTP 全流程：分域确认 → 构建 → 投递 → 真实样例回执 → 待重发范围", async () => {
  await withServer(async (base) => {
    const post = (path, body, actor) => jsonRequest(base, "POST", path, body, actor);
    const get = (path, actor) => jsonRequest(base, "GET", path, undefined, actor);

    assert.equal((await get("/health")).status, 200);

    const { status: regStatus } = await post("/objects", {
      objectId: "o1",
      kind: "original",
      label: "青铜鼎",
    }, curator);
    assert.equal(regStatus, 200);

    await post("/objects/o1/facts", { body: { name: "青铜鼎", period: "商代晚期" } }, curator);

    // 越权确认在 HTTP 层返回 403。
    const denied = await post(
      "/objects/o1/components",
      { componentType: "alt-text", body: { text: "图" } },
      copyright
    );
    // 版权人员不能起草组件。
    assert.equal(denied.status, 403);

    for (const type of COMPONENT_TYPES) {
      await post(
        "/objects/o1/components",
        { componentType: type, body: { text: `${type} 正文` } },
        editor
      );
      // 各组件类型版本独立编号，均从 c1 开始。
      const r = await post(
        `/objects/o1/components/${type}/c1/confirm`,
        undefined,
        type === "terminology" ? curator : a11y
      );
      assert.equal(r.status, 200, `${type} 确认应成功`);
    }
    await post("/objects/o1/images/grant", { imageId: "img-1" }, copyright);

    const built = await post("/objects/o1/packages", {}, editor);
    assert.equal(built.status, 200);
    assert.equal(built.payload.blocking.length, 0);

    const dispatched = await post(
      "/objects/o1/dispatches",
      { channels: ["miniapp", "audio-guide"], digest: built.payload.digest },
      editor
    );
    assert.equal(dispatched.payload.dispatchIds.length, 2);

    // 直接投递仓库中的真实回执样例（accepted 不代表展示）。
    const samples = JSON.parse(readFileSync(new URL("../contracts/channel-receipts.json", import.meta.url)));
    for (const receipt of samples) {
      const r = await post("/receipts", { ...receipt, package_digest: built.payload.digest }, null);
      assert.equal(r.status, 200);
      assert.equal(r.payload.duplicate, false);
    }
    // 同一回执重复投递。
    const repeat = await post(
      "/receipts",
      { ...samples[0], package_digest: built.payload.digest },
      null
    );
    assert.equal(repeat.payload.duplicate, true);

    const scope = await get("/objects/o1/resend-scope", editor);
    assert.equal(scope.payload.channels.miniapp.status, "displayed-current");
    assert.equal(scope.payload.channels["audio-guide"].status, "in-flight");
    assert.equal(scope.payload.channels["audio-guide"].awaitingDisplay, true);
  });
});

test("HTTP 观众纠错与紧急纠错：公开入口无需身份，联系方式仅协调员可读，办结三要素齐备", async () => {
  await withServer(async (base) => {
    const post = (path, body, actor) => jsonRequest(base, "POST", path, body, actor);
    const get = (path, actor) => jsonRequest(base, "GET", path, undefined, actor);

    await post("/objects", { objectId: "o1", kind: "touch-replica", label: "复制品鼎" }, curator);
    await post("/objects/o1/facts", { body: { name: "青铜鼎（复制品）" } }, curator);
    for (const type of COMPONENT_TYPES) {
      await post("/objects/o1/components", { componentType: type, body: { text: type } }, editor);
      await post(
        `/objects/o1/components/${type}/c1/confirm`,
        undefined,
        type === "terminology" ? curator : a11y
      );
    }
    const built = (await post("/objects/o1/packages", {}, editor)).payload;
    await post("/objects/o1/dispatches", { channels: ["miniapp"], digest: built.digest }, editor);
    const now = new Date().toISOString();
    await post(
      "/receipts",
      {
        receipt_id: "mini-http-1",
        channel: "miniapp",
        package_digest: built.digest,
        status: "displayed",
        received_at: now,
        displayed_at: now,
      },
      null
    );

    // 观众无需身份提交纠错，并可留下联系方式。
    const filed = await post(
      "/corrections",
      { objectId: "o1", channels: ["miniapp"], description: "标签与语音说法不一致", contact: "a@b.cn" },
      null
    );
    assert.equal(filed.status, 200);
    const correctionId = filed.payload.correctionId;

    // 普通编辑列表看不到联系方式，也无权读取。
    const list = await get("/corrections", editor);
    assert.equal("contact" in list.payload.corrections[0], false);
    assert.equal((await get(`/corrections/${correctionId}/contact`, editor)).status, 403);
    const contact = await get(`/corrections/${correctionId}/contact`, coordinator);
    assert.equal(contact.payload.contact, "a@b.cn");

    // 紧急撤下。
    const pulled = await post(
      "/objects/o1/emergency-pull",
      { channels: ["miniapp"], harmfulDescription: "误导表述" },
      editor
    );
    assert.equal(pulled.status, 200);
    const scope = await get("/objects/o1/resend-scope", editor);
    assert.equal(scope.payload.channels.miniapp.status, "pulled");

    // 办结缺批准人被拒。
    const incomplete = await post(
      `/corrections/${pulled.payload.correctionId}/resolve`,
      { reason: "已更正", replacementDispatchId: "nonexistent" },
      coordinator
    );
    assert.equal(incomplete.status, 400);
    assert.ok(incomplete.payload.details.missing.includes("approver"));
  });
});

test("HTTP 未知路由与错误请求返回结构化错误", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonRequest(base, "GET", "/nope")).status, 404);
    const bad = await fetch(`${base}/objects/o1/facts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-id": "x", "x-actor-role": ROLES.CURATOR },
      body: "{not-json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "bad-request");
  });
});
