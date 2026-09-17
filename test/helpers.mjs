import { EventStore, createClock } from "../src/domain/store.mjs";
import { PublishingService } from "../src/domain/service.mjs";
import { CHANNEL_PROFILES, COMPONENT_TYPES, ROLES } from "../src/domain/roles.mjs";

export const actors = {
  curator: { id: "u-curator", role: ROLES.CURATOR },
  a11y: { id: "u-a11y", role: ROLES.ACCESSIBILITY },
  copyright: { id: "u-copyright", role: ROLES.COPYRIGHT },
  editor: { id: "u-editor", role: ROLES.EDITOR },
  coordinator: { id: "u-coord", role: ROLES.COORDINATOR },
};

// 建立一个已登记、事实齐备、五类组件均已分域确认、图片已授权的对象。
export function setupReadyObject(service, objectId, { kind = "original", imageIds = ["img-1"] } = {}) {
  service.registerObject(actors.curator, { objectId, kind, label: objectId });
  service.recordFact(actors.curator, {
    objectId,
    body: { name: "青铜鼎", period: "商代晚期", basis: "类型学" },
    basis: "2026 年馆藏研究",
  });
  draftAndConfirmAll(service, objectId, { suffix: "" });
  for (const imageId of imageIds) {
    service.grantImageLicense(actors.copyright, { objectId, imageId });
  }
}

export function draftAndConfirmAll(service, objectId, { suffix = "" } = {}) {
  for (const type of COMPONENT_TYPES) {
    draftAndConfirm(service, objectId, type, { suffix });
  }
}

export function draftAndConfirm(service, objectId, type, { suffix = "" } = {}) {
  const state = service.snapshot();
  const family = state.objects[objectId].components[type];
  const version = `c${Object.keys(family?.revisions ?? {}).length + 1}`;
  service.draftComponent(actors.editor, { objectId, componentType: type, body: bodyFor(type, suffix) });
  const confirmer = type === "terminology" ? actors.curator : actors.a11y;
  service.confirmComponent(confirmer, { objectId, componentType: type, version });
  return version;
}

export function bodyFor(type, suffix = "") {
  const bodies = {
    terminology: { term: "青铜鼎（原件）", objectNature: "original" },
    "alt-text": { text: `青铜鼎正面照，三足两耳${suffix}` },
    "tactile-cue": { text: `轮廓凸起处为耳部，下方三足可辨${suffix}` },
    "easy-read": { text: `这是一只古老的青铜鼎${suffix}` },
    "audio-script": { text: `您面前的青铜鼎铸于商代晚期${suffix}` },
  };
  return bodies[type];
}

export function buildAndDispatchAll(service, clock, objectId, { channels } = {}) {
  const built = service.buildPackage(actors.editor, { objectId });
  if (clock) clock.advance(10);
  const targetChannels = channels ?? Object.keys(CHANNEL_PROFILES);
  const { dispatchIds } = service.dispatchPackage(actors.editor, {
    objectId,
    channels: targetChannels,
    digest: built.digest,
  });
  return { digest: built.digest, dispatchIds };
}

export function newHarness(start = "2026-09-12T08:00:00+08:00") {
  const clock = createClock(start);
  const store = new EventStore({ clock });
  const service = new PublishingService(store);
  return { clock, store, service };
}
