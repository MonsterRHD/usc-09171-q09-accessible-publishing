import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/domain/errors.mjs";
import { actors, draftAndConfirm, newHarness, setupReadyObject } from "./helpers.mjs";

const assertForbidden = (fn) => {
  try {
    fn();
    assert.fail("应当拒绝");
  } catch (error) {
    assert.ok(error instanceof DomainError && error.status === 403);
  }
};

const TYPES = ["terminology", "alt-text", "tactile-cue", "easy-read", "audio-script"];

test("原件与可触摸复制品是不同对象，复制品内容包不能以原件名义投递", () => {
  const { service } = newHarness();
  setupReadyObject(service, "ding-original", { kind: "original" });
  setupReadyObject(service, "ding-replica", { kind: "touch-replica", imageIds: [] });

  const replicaPkg = service.buildPackage(actors.editor, { objectId: "ding-replica" });
  assert.equal(replicaPkg.blocking.length, 0);

  // 触摸标签上“可触摸复制品”的包绝不能挂到原件渠道身份下。
  assert.throws(
    () =>
      service.dispatchPackage(actors.editor, {
        objectId: "ding-original",
        channels: ["touch-label"],
        digest: replicaPkg.digest,
      }),
    /禁止跨对象投递/
  );
});

test("分域确认：馆员不能确认替代文本，无障碍顾问不能确认术语", () => {
  const { service } = newHarness();
  service.registerObject(actors.curator, { objectId: "o1", kind: "original", label: "o1" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "商" } });
  service.draftComponent(actors.editor, { objectId: "o1", componentType: "alt-text", body: { text: "图" } });
  service.draftComponent(actors.editor, {
    objectId: "o1",
    componentType: "terminology",
    body: { term: "原件" },
  });

  assert.throws(
    () => service.confirmComponent(actors.curator, { objectId: "o1", componentType: "alt-text", version: "c1" }),
    /不能执行确认 alt-text/
  );
  assert.throws(
    () => service.confirmComponent(actors.a11y, { objectId: "o1", componentType: "terminology", version: "c1" }),
    /不能执行确认 terminology/
  );
  // 版权人员只能管授权，不能碰术语确认。
  assertForbidden(() =>
    service.confirmComponent(actors.copyright, { objectId: "o1", componentType: "terminology", version: "c1" })
  );
});

test("事实撤回后：旧确认不能继续发布，必须按新事实重新起草并确认", () => {
  const { service } = newHarness();
  setupReadyObject(service, "o1", { imageIds: [] });
  service.retractFact(actors.curator, { objectId: "o1", version: "f1", reason: "年代判断撤回" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "西周早期" } });

  const blocked = service.buildPackage(actors.editor, { objectId: "o1" });
  assert.equal(blocked.digest, null);
  const scopes = blocked.blocking.map((b) => b.scope).sort();
  assert.deepEqual(scopes, ["alt-text", "audio-script", "easy-read", "tactile-cue", "terminology"]);
  for (const b of blocked.blocking) assert.match(b.reason, /f2/);
});

test("五类组件与图片授权全部就绪，内容包才能通过门禁", () => {
  const { service } = newHarness();
  service.registerObject(actors.curator, { objectId: "o1", kind: "original", label: "o1" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "商" } });
  const first = service.buildPackage(actors.editor, { objectId: "o1" });
  assert.equal(first.digest, null);
  assert.equal(first.blocking.length, 5);

  // 每补齐一类组件，门禁缺口相应减少；最后一类就绪前一律不得发布。
  for (const [index, type] of TYPES.entries()) {
    draftAndConfirm(service, "o1", type);
    const partial = service.buildPackage(actors.editor, { objectId: "o1" });
    if (index < TYPES.length - 1) {
      assert.equal(partial.digest, null);
      assert.equal(partial.blocking.length, TYPES.length - index - 1);
    }
  }
  // 五类组件齐全后（该对象无图片）通过门禁。
  const ready = service.buildPackage(actors.editor, { objectId: "o1" });
  assert.equal(ready.blocking.length, 0);
  assert.match(ready.digest, /^sha256:/);
});

test("基于已撤回事实的组件版本拒绝确认，不能借确认复活", () => {
  const { service } = newHarness();
  service.registerObject(actors.curator, { objectId: "o1", kind: "original", label: "o1" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "商晚期" } });
  // 只起草、尚未确认，随后事实被撤回。
  service.draftComponent(actors.editor, {
    objectId: "o1",
    componentType: "audio-script",
    body: { text: "铸于商代晚期" },
  });
  service.retractFact(actors.curator, { objectId: "o1", version: "f1", reason: "年代判断撤回" });
  service.recordFact(actors.curator, { objectId: "o1", body: { period: "西周早期" } });
  assert.throws(
    () => service.confirmComponent(actors.a11y, { objectId: "o1", componentType: "audio-script", version: "c1" }),
    /事实版本已撤回/
  );
});
