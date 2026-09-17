import crypto from "node:crypto";
import { nextId, recordEvent } from "./store.mjs";
import { DomainError, assessAssetVersion, mustObject } from "./domain.mjs";
import { currentDisplay } from "./timeline.mjs";

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 内容包摘要：同一内容包投递到多个渠道时摘要一致，与既有回执样例的约定兼容
export function packageDigest(objectId, contents) {
  const payload = stableStringify({ object_id: objectId, contents });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

// 组包：逐资产取"最新且通过评估"的版本；确认不齐或依赖失效的版本不会进入内容包，
// 旧审核不会成为继续发布的理由。
export function buildPackage(state, objectId, kinds) {
  const contents = [];
  const skipped = [];
  for (const asset of state.assets.values()) {
    if (asset.object_id !== objectId) continue;
    if (kinds && !kinds.includes(asset.kind)) continue;
    let chosen = null;
    const versions = [...asset.versions].sort((a, b) => b.version - a.version);
    for (const version of versions) {
      if (version.status !== "active") continue;
      if (assessAssetVersion(state, asset, version).status === "cleared") {
        chosen = version;
        break;
      }
    }
    if (chosen) {
      contents.push({ asset_id: asset.id, version: chosen.version, kind: asset.kind, body: chosen.body });
    } else {
      skipped.push({ asset_id: asset.id, kind: asset.kind, reason: "no_cleared_version" });
    }
  }
  contents.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
  return { contents, skipped };
}

export function publish(state, actor, input = {}) {
  const { object_id, channels, kinds } = input;
  mustObject(state, object_id);
  if (!Array.isArray(channels) || channels.length === 0 || channels.some((c) => typeof c !== "string" || !c)) {
    throw new DomainError(400, "invalid_channels", "发布需要至少一个渠道");
  }
  if (kinds !== undefined && !Array.isArray(kinds)) {
    throw new DomainError(400, "invalid_kinds", "kinds 必须是数组");
  }
  const { contents, skipped } = buildPackage(state, object_id, kinds);
  if (contents.length === 0) {
    throw new DomainError(409, "nothing_cleared", "没有确认齐全且依赖有效的内容版本，无法发布", { skipped });
  }
  const digest = packageDigest(object_id, contents);
  const publication = {
    id: nextId(state, "pub"),
    object_id,
    digest,
    contents,
    skipped,
    created_at: state.now(),
    created_by: actor.id,
    deliveries: [],
  };
  state.publications.set(publication.id, publication);
  for (const channel of new Set(channels)) {
    // 同一 (渠道, 对象) 上尚未落地的旧投递直接作废，避免旧内容之后被渠道展示
    for (const d of state.deliveries.values()) {
      if (
        d.channel === channel &&
        d.object_id === object_id &&
        ["pending", "failed", "awaiting_receipt", "accepted"].includes(d.status)
      ) {
        d.status = "superseded";
        recordEvent(state, "delivery_superseded", {
          delivery_id: d.id,
          channel,
          object_id,
          digest: d.digest,
          replaced_by: publication.id,
        });
      }
    }
    const delivery = {
      id: nextId(state, "del"),
      publication_id: publication.id,
      channel,
      object_id,
      digest,
      status: "pending",
      attempts: 0,
      last_error: null,
      accepted_at: null,
      displayed_at: null,
      history: [],
    };
    state.deliveries.set(delivery.id, delivery);
    publication.deliveries.push(delivery.id);
  }
  recordEvent(state, "publication_created", {
    publication_id: publication.id,
    object_id,
    digest,
    channels: [...new Set(channels)],
  });
  return publication;
}

// 投递尝试：记录失败与重试；成功发出后等待渠道回执
export function attemptDelivery(state, deliveryId, input = {}) {
  const delivery = state.deliveries.get(deliveryId);
  if (!delivery) throw new DomainError(404, "delivery_not_found", `投递 ${deliveryId} 不存在`);
  if (!["pending", "failed"].includes(delivery.status)) {
    throw new DomainError(409, "invalid_delivery_state", `投递当前状态为 ${delivery.status}，不能重复发出`);
  }
  const { outcome, error } = input;
  if (!["sent", "failed"].includes(outcome)) {
    throw new DomainError(400, "invalid_outcome", "outcome 必须是 sent 或 failed");
  }
  delivery.attempts += 1;
  if (outcome === "sent") {
    delivery.status = "awaiting_receipt";
    delivery.last_error = null;
  } else {
    delivery.status = "failed";
    delivery.last_error = error ?? "unknown";
  }
  delivery.history.push({ at: state.now(), outcome, error: outcome === "failed" ? delivery.last_error : null });
  recordEvent(state, "delivery_attempt", {
    delivery_id: delivery.id,
    channel: delivery.channel,
    object_id: delivery.object_id,
    outcome,
    error: delivery.last_error,
    attempts: delivery.attempts,
  });
  return delivery;
}

// 渠道回执：accepted（收到内容包）与 displayed（已经展示）是两个不同状态；
// displayed_at 为空不能视为已展示；同一回执允许重复投递，按 receipt_id 幂等去重。
export function ingestReceipt(state, channel, body = {}) {
  const { receipt_id, package_digest, status, received_at, displayed_at = null } = body;
  for (const [field, value] of Object.entries({ receipt_id, package_digest, status, received_at })) {
    if (value === undefined || value === null || value === "") {
      throw new DomainError(400, "invalid_receipt", `回执缺少字段 ${field}`);
    }
  }
  if (body.channel !== channel) {
    throw new DomainError(400, "channel_mismatch", "回执 channel 与请求路径不一致");
  }
  if (!["accepted", "displayed"].includes(status)) {
    throw new DomainError(400, "invalid_receipt_status", "回执状态必须是 accepted 或 displayed");
  }
  if (status === "displayed" && !displayed_at) {
    throw new DomainError(400, "displayed_requires_time", "displayed 状态的回执必须携带 displayed_at");
  }
  if (status === "accepted" && displayed_at) {
    throw new DomainError(400, "accepted_must_not_display", "accepted 状态不应携带 displayed_at");
  }

  const existing = state.receipts.get(receipt_id);
  if (existing) {
    const same =
      existing.channel === channel &&
      existing.package_digest === package_digest &&
      existing.status === status &&
      existing.received_at === received_at &&
      (existing.displayed_at ?? null) === displayed_at;
    if (!same) {
      throw new DomainError(409, "receipt_conflict", "相同 receipt_id 的回执内容不一致");
    }
    recordEvent(state, "receipt_duplicate", { receipt_id, channel });
    return { receipt: existing, duplicate: true, matched: existing.matched };
  }

  // 按 (渠道, 摘要) 匹配最新的未作废投递（同一内容重发时摘要可能相同，取最新一条）
  let delivery = null;
  for (const d of state.deliveries.values()) {
    if (d.channel === channel && d.digest === package_digest && d.status !== "superseded") {
      if (!delivery || Number(d.id.split("-")[1]) > Number(delivery.id.split("-")[1])) delivery = d;
    }
  }

  const receipt = {
    receipt_id,
    channel,
    package_digest,
    status,
    received_at,
    displayed_at,
    ingested_at: state.now(),
    matched: Boolean(delivery),
    delivery_id: delivery ? delivery.id : null,
  };
  state.receipts.set(receipt_id, receipt);
  recordEvent(state, "receipt_received", {
    receipt_id,
    channel,
    package_digest,
    status,
    matched: receipt.matched,
  });

  if (delivery) {
    const publication = state.publications.get(delivery.publication_id);
    if (status === "accepted" && ["pending", "failed", "awaiting_receipt"].includes(delivery.status)) {
      delivery.status = "accepted";
      delivery.accepted_at = received_at;
      recordEvent(state, "delivery_accepted", {
        delivery_id: delivery.id,
        publication_id: delivery.publication_id,
        channel,
        object_id: delivery.object_id,
        digest: delivery.digest,
        effective_at: received_at,
      });
    }
    if (status === "displayed") {
      const afterTakedown = delivery.status === "taken_down";
      if (!delivery.accepted_at) {
        delivery.accepted_at = received_at;
        recordEvent(state, "delivery_accepted", {
          delivery_id: delivery.id,
          publication_id: delivery.publication_id,
          channel,
          object_id: delivery.object_id,
          digest: delivery.digest,
          effective_at: received_at,
        });
      }
      if (!afterTakedown) {
        delivery.status = "displayed";
        delivery.displayed_at = displayed_at;
      }
      recordEvent(state, "delivery_displayed", {
        delivery_id: delivery.id,
        publication_id: delivery.publication_id,
        channel,
        object_id: delivery.object_id,
        digest: delivery.digest,
        effective_at: displayed_at,
        after_takedown: afterTakedown,
        contents: publication ? publication.contents : undefined,
      });
    }
  }
  return { receipt, duplicate: false, matched: receipt.matched };
}

// 公开端视图：只输出当前仍在展示、且逐项重新评估过的内容；
// 依赖被撤回的条目立即从公开端消失（止血），被取代的条目标记 stale。
export function publicView(state, channel, objectId) {
  const current = currentDisplay(state, channel, objectId);
  if (!current) {
    throw new DomainError(404, "not_displayed", "该渠道当前没有公开展示此对象的内容");
  }
  const publication = state.publications.get(current.publication_id);
  if (!publication) {
    throw new DomainError(404, "publication_not_found", "展示中的内容包不存在");
  }
  const items = [];
  const withheld = [];
  for (const c of publication.contents) {
    const asset = state.assets.get(c.asset_id);
    const version = asset ? asset.versions.find((v) => v.version === c.version) : null;
    const assessment = asset && version ? assessAssetVersion(state, asset, version) : null;
    if (assessment && assessment.status === "cleared") {
      items.push({ kind: c.kind, asset_id: c.asset_id, version: c.version, body: c.body });
    } else if (assessment && assessment.status === "stale") {
      items.push({ kind: c.kind, asset_id: c.asset_id, version: c.version, body: c.body, stale: true, stale_reasons: assessment.reasons });
    } else {
      withheld.push({
        kind: c.kind,
        asset_id: c.asset_id,
        version: c.version,
        reasons: assessment ? assessment.reasons : ["资产不存在"],
      });
    }
  }
  if (items.length === 0) {
    throw new DomainError(410, "content_withdrawn", "内容已撤回，等待替代版本", { withheld });
  }
  return {
    channel,
    object_id: objectId,
    digest: current.digest,
    publication_id: current.publication_id,
    displayed_since: current.since,
    items,
    withheld,
  };
}

export function deliveryView(delivery) {
  return {
    id: delivery.id,
    publication_id: delivery.publication_id,
    channel: delivery.channel,
    object_id: delivery.object_id,
    digest: delivery.digest,
    status: delivery.status,
    attempts: delivery.attempts,
    last_error: delivery.last_error,
    accepted_at: delivery.accepted_at,
    displayed_at: delivery.displayed_at,
    history: delivery.history,
  };
}

// 发布结果视图：逐渠道的实际状态，部分上线一目了然
export function publicationView(state, publication) {
  const deliveries = publication.deliveries.map((id) => state.deliveries.get(id));
  const channels = deliveries.map((d) => ({
    ...deliveryView(d),
    currently_displaying: currentDisplay(state, d.channel, d.object_id)?.delivery_id === d.id,
  }));
  const displayedCount = channels.filter((c) => c.currently_displaying).length;
  return {
    id: publication.id,
    object_id: publication.object_id,
    digest: publication.digest,
    contents: publication.contents,
    skipped: publication.skipped,
    created_at: publication.created_at,
    created_by: publication.created_by,
    channels,
    partially_live: displayedCount > 0 && displayedCount < channels.length,
  };
}
