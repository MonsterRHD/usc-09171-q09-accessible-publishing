import { assessAssetVersion } from "./domain.mjs";
import { currentDisplay } from "./timeline.mjs";

// 变更影响计算：核心事实或授权变化时，精确算出必须失效的渠道内容。
// change 形如 { fact_id, version } 或 { license_id }。
export function impactOfChange(state, change) {
  const depends = change.fact_id
    ? (version) => version.deps.facts.some((f) => f.fact_id === change.fact_id && f.version === change.version)
    : (version) => version.deps.licenses.includes(change.license_id);

  const affectedAssets = [];
  const assetKeys = new Set();
  for (const asset of state.assets.values()) {
    for (const version of asset.versions) {
      if (depends(version)) {
        affectedAssets.push({
          asset_id: asset.id,
          object_id: asset.object_id,
          kind: asset.kind,
          version: version.version,
        });
        assetKeys.add(`${asset.id}@${version.version}`);
      }
    }
  }

  const affectedDeliveries = [];
  for (const delivery of state.deliveries.values()) {
    if (["superseded", "taken_down"].includes(delivery.status)) continue;
    const publication = state.publications.get(delivery.publication_id);
    if (!publication) continue;
    if (!publication.contents.some((c) => assetKeys.has(`${c.asset_id}@${c.version}`))) continue;
    affectedDeliveries.push({
      delivery_id: delivery.id,
      publication_id: delivery.publication_id,
      channel: delivery.channel,
      object_id: delivery.object_id,
      digest: delivery.digest,
      delivery_status: delivery.status,
      currently_displayed: currentDisplay(state, delivery.channel, delivery.object_id)?.delivery_id === delivery.id,
    });
  }
  return { change, affected_assets: affectedAssets, affected_deliveries: affectedDeliveries };
}

// 评估一个内容包内各条目当前的有效性
export function assessContents(state, publication) {
  const invalid = [];
  const stale = [];
  for (const c of publication.contents) {
    const asset = state.assets.get(c.asset_id);
    const version = asset ? asset.versions.find((v) => v.version === c.version) : null;
    if (!asset || !version) {
      invalid.push({ asset_id: c.asset_id, version: c.version, kind: c.kind, reasons: ["资产不存在"] });
      continue;
    }
    const assessment = assessAssetVersion(state, asset, version);
    if (assessment.status === "invalid" || assessment.status === "unconfirmed") {
      invalid.push({ asset_id: c.asset_id, version: c.version, kind: c.kind, reasons: assessment.reasons.concat(assessment.missing_confirmations.map((d) => `缺少 ${d} 域确认`)) });
    } else if (assessment.status === "stale") {
      stale.push({ asset_id: c.asset_id, version: c.version, kind: c.kind, reasons: assessment.reasons });
    }
  }
  return { invalid, stale };
}

// 编辑的待重发范围：哪些渠道正在展示失效内容、哪些已接收但未展示的内容必须先替换、
// 哪些投递失败待重试，以及尚未补齐的紧急撤下。
export function republishScope(state) {
  const pairs = new Map();
  for (const delivery of state.deliveries.values()) {
    const key = `${delivery.channel} ${delivery.object_id}`;
    if (!pairs.has(key)) pairs.set(key, { channel: delivery.channel, object_id: delivery.object_id, deliveries: [] });
    pairs.get(key).deliveries.push(delivery);
  }

  const channels = [];
  for (const { channel, object_id, deliveries } of pairs.values()) {
    const current = currentDisplay(state, channel, object_id);
    const displayedIssues = { invalid: [], stale: [] };
    if (current) {
      const publication = state.publications.get(current.publication_id);
      if (publication) {
        const { invalid, stale } = assessContents(state, publication);
        displayedIssues.invalid = invalid;
        displayedIssues.stale = stale;
      }
    }
    const inFlight = deliveries.filter((d) => ["pending", "awaiting_receipt", "accepted"].includes(d.status));
    const inFlightIssues = [];
    for (const d of inFlight) {
      const publication = state.publications.get(d.publication_id);
      if (!publication) continue;
      const { invalid, stale } = assessContents(state, publication);
      if (invalid.length > 0 || stale.length > 0) {
        inFlightIssues.push({ delivery_id: d.id, digest: d.digest, delivery_status: d.status, invalid, stale });
      }
    }
    const failed = deliveries
      .filter((d) => d.status === "failed")
      .map((d) => ({ delivery_id: d.id, digest: d.digest, attempts: d.attempts, last_error: d.last_error }));

    let action = null;
    if (displayedIssues.invalid.length > 0) action = "urgent_republish"; // 公开端正在展示已失效内容
    else if (displayedIssues.stale.length > 0) action = "republish"; // 展示内容已被新版本取代
    else if (inFlightIssues.length > 0) action = "replace_before_display"; // 渠道已接收但尚未展示，先替换再上线
    else if (failed.length > 0) action = "retry"; // 投递失败待重试

    if (action) {
      channels.push({
        channel,
        object_id,
        action,
        current_display: current
          ? { delivery_id: current.delivery_id, publication_id: current.publication_id, digest: current.digest, since: current.since }
          : null,
        displayed_issues: displayedIssues,
        in_flight_issues: inFlightIssues,
        failed_deliveries: failed,
      });
    }
  }

  return {
    generated_at: state.now(),
    channels,
    open_takedowns: [...state.takedowns.values()].filter((t) => t.status === "open").map(takedownView),
    unmatched_receipts: [...state.receipts.values()].filter((r) => !r.matched),
  };
}

export function takedownView(t) {
  return {
    id: t.id,
    channel: t.channel,
    object_id: t.object_id,
    delivery_id: t.delivery_id,
    publication_id: t.publication_id,
    digest: t.digest,
    status: t.status,
    reason: t.reason,
    replacement_publication_id: t.replacement_publication_id,
    approver: t.approver,
    created_at: t.created_at,
    created_by: t.created_by,
    backfilled_at: t.backfilled_at,
    missing_fields: t.status === "open"
      ? [
          ...(t.reason ? [] : ["reason"]),
          ...(t.replacement_publication_id ? [] : ["replacement_publication_id"]),
          ...(t.approver ? [] : ["approver"]),
        ]
      : [],
  };
}
