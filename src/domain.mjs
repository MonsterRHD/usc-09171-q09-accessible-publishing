import { nextId, recordEvent } from "./store.mjs";

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------- 语义资产种类与分域 ----------
// 馆员(curator)负责 curatorial 域，无障碍顾问(accessibility)负责 accessibility 域，
// 版权人员(copyright)负责 rights 域；任何人只能确认自己负责的域。
export const ASSET_KINDS = ["terminology", "alt_text", "tactile_hint", "easy_read", "audio_script", "image"];

export const KIND_DOMAINS = {
  terminology: ["curatorial"],
  alt_text: ["accessibility"],
  tactile_hint: ["accessibility"],
  easy_read: ["accessibility"],
  audio_script: ["curatorial", "accessibility"],
  image: ["rights"],
};

export const ROLE_DOMAINS = {
  curator: ["curatorial"],
  accessibility: ["accessibility"],
  copyright: ["rights"],
  admin: ["curatorial", "accessibility", "rights"],
};

export function domainsForRole(role) {
  return ROLE_DOMAINS[role] ?? [];
}

// ---------- 展品对象：原件与复制品严格分离 ----------
export function createObject(state, actor, input = {}) {
  const { kind, name, replica_of = null } = input;
  if (!["original", "replica"].includes(kind)) {
    throw new DomainError(400, "invalid_kind", "对象类型必须是 original 或 replica");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new DomainError(400, "invalid_name", "对象需要名称");
  }
  if (kind === "replica") {
    const origin = replica_of ? state.objects.get(replica_of) : null;
    if (!origin || origin.kind !== "original") {
      throw new DomainError(400, "replica_requires_original", "复制品必须通过 replica_of 关联已存在的原件");
    }
  }
  const object = {
    id: nextId(state, "obj"),
    kind,
    name,
    replica_of: kind === "replica" ? replica_of : null,
    created_at: state.now(),
    created_by: actor.id,
  };
  state.objects.set(object.id, object);
  recordEvent(state, "object_created", { object_id: object.id, kind, name, replica_of: object.replica_of });
  return object;
}

// ---------- 事实：按对象版本化，跨渠道共用 ----------
export function createFact(state, actor, input = {}) {
  const { object_id, key, value } = input;
  mustObject(state, object_id);
  if (typeof key !== "string" || key.length === 0) {
    throw new DomainError(400, "invalid_key", "事实需要键名");
  }
  const fact = { id: nextId(state, "fact"), object_id, key, versions: [] };
  state.facts.set(fact.id, fact);
  return addFactVersion(state, actor, fact.id, value).fact;
}

export function addFactVersion(state, actor, factId, value) {
  const fact = mustFact(state, factId);
  if (value === undefined || value === null) {
    throw new DomainError(400, "invalid_value", "事实版本需要取值");
  }
  const previous = currentFactVersion(fact);
  if (previous) previous.status = "superseded";
  const version = {
    version: fact.versions.length + 1,
    value,
    status: "current",
    created_at: state.now(),
    created_by: actor.id,
  };
  fact.versions.push(version);
  recordEvent(state, "fact_version_created", {
    fact_id: fact.id,
    object_id: fact.object_id,
    key: fact.key,
    version: version.version,
    superseded_version: previous ? previous.version : null,
  });
  return { fact, version, superseded: previous };
}

export function withdrawFactVersion(state, actor, factId, versionNumber) {
  const fact = mustFact(state, factId);
  const version = fact.versions.find((v) => v.version === versionNumber);
  if (!version) throw new DomainError(404, "fact_version_not_found", `事实 ${factId} 没有版本 ${versionNumber}`);
  if (version.status === "withdrawn") throw new DomainError(409, "already_withdrawn", "该事实版本已撤回");
  if (version.status !== "current") {
    throw new DomainError(409, "not_current", "只有当前生效的事实版本可以撤回；旧版本已被取代，无需撤回");
  }
  version.status = "withdrawn";
  version.withdrawn_at = state.now();
  version.withdrawn_by = actor.id;
  recordEvent(state, "fact_version_withdrawn", {
    fact_id: fact.id,
    object_id: fact.object_id,
    key: fact.key,
    version: version.version,
  });
  return { fact, version };
}

export function currentFactVersion(fact) {
  return fact.versions.find((v) => v.status === "current") ?? null;
}

export function getFactVersion(fact, versionNumber) {
  return fact.versions.find((v) => v.version === versionNumber) ?? null;
}

// ---------- 授权 ----------
export function createLicense(state, actor, input = {}) {
  const { title } = input;
  if (typeof title !== "string" || title.length === 0) {
    throw new DomainError(400, "invalid_title", "授权需要名称");
  }
  const license = {
    id: nextId(state, "lic"),
    title,
    status: "active",
    created_at: state.now(),
    created_by: actor.id,
    withdrawn_at: null,
  };
  state.licenses.set(license.id, license);
  recordEvent(state, "license_created", { license_id: license.id, title });
  return license;
}

export function withdrawLicense(state, actor, licenseId) {
  const license = state.licenses.get(licenseId);
  if (!license) throw new DomainError(404, "license_not_found", `授权 ${licenseId} 不存在`);
  if (license.status === "withdrawn") throw new DomainError(409, "already_withdrawn", "该授权已撤回");
  license.status = "withdrawn";
  license.withdrawn_at = state.now();
  license.withdrawn_by = actor.id;
  recordEvent(state, "license_withdrawn", { license_id: license.id });
  return license;
}

// ---------- 语义资产 ----------
export function createAsset(state, actor, input = {}) {
  const { object_id, kind, body, deps } = input;
  mustObject(state, object_id);
  if (!ASSET_KINDS.includes(kind)) {
    throw new DomainError(400, "invalid_asset_kind", `资产类型必须是 ${ASSET_KINDS.join("/")} 之一`);
  }
  if (body === undefined || body === null) {
    throw new DomainError(400, "invalid_body", "资产版本需要内容体");
  }
  const normalizedDeps = normalizeDeps(state, object_id, kind, deps ?? {});
  const asset = { id: nextId(state, "asset"), object_id, kind, versions: [] };
  asset.versions.push({
    version: 1,
    body,
    deps: normalizedDeps,
    status: "active",
    created_at: state.now(),
    created_by: actor.id,
  });
  state.assets.set(asset.id, asset);
  recordEvent(state, "asset_version_created", { asset_id: asset.id, object_id, kind, version: 1 });
  return asset;
}

export function addAssetVersion(state, actor, assetId, input = {}) {
  const asset = mustAsset(state, assetId);
  const { body, deps } = input;
  if (body === undefined || body === null) {
    throw new DomainError(400, "invalid_body", "资产版本需要内容体");
  }
  // 未显式给出依赖时沿用上一版本的依赖（重新校验对象边界）
  const previous = asset.versions[asset.versions.length - 1];
  const normalizedDeps = normalizeDeps(state, asset.object_id, asset.kind, deps ?? previous.deps);
  const version = {
    version: asset.versions.length + 1,
    body,
    deps: normalizedDeps,
    status: "active",
    created_at: state.now(),
    created_by: actor.id,
  };
  asset.versions.push(version);
  recordEvent(state, "asset_version_created", {
    asset_id: asset.id,
    object_id: asset.object_id,
    kind: asset.kind,
    version: version.version,
  });
  return { asset, version };
}

export function withdrawAssetVersion(state, actor, assetId, versionNumber) {
  const asset = mustAsset(state, assetId);
  const version = asset.versions.find((v) => v.version === versionNumber);
  if (!version) throw new DomainError(404, "asset_version_not_found", `资产 ${assetId} 没有版本 ${versionNumber}`);
  if (version.status === "withdrawn") throw new DomainError(409, "already_withdrawn", "该资产版本已撤回");
  version.status = "withdrawn";
  version.withdrawn_at = state.now();
  version.withdrawn_by = actor.id;
  recordEvent(state, "asset_version_withdrawn", {
    asset_id: asset.id,
    object_id: asset.object_id,
    kind: asset.kind,
    version: version.version,
  });
  return { asset, version };
}

// 依赖校验：事实必须属于同一对象，从源头阻断复制品描述传播到原件（或反向）
function normalizeDeps(state, objectId, kind, deps) {
  const facts = (deps.facts ?? []).map((ref) => {
    const fact = state.facts.get(ref.fact_id);
    if (!fact) throw new DomainError(400, "unknown_fact", `事实 ${ref.fact_id} 不存在`);
    if (fact.object_id !== objectId) {
      throw new DomainError(
        400,
        "cross_object_reference",
        `事实 ${ref.fact_id} 属于对象 ${fact.object_id}，不能用于对象 ${objectId} 的内容；原件与复制品的描述不得互相传播`,
      );
    }
    if (!getFactVersion(fact, ref.version)) {
      throw new DomainError(400, "unknown_fact_version", `事实 ${ref.fact_id} 没有版本 ${ref.version}`);
    }
    return { fact_id: ref.fact_id, version: ref.version };
  });
  const licenses = (deps.licenses ?? []).map((licenseId) => {
    if (!state.licenses.has(licenseId)) {
      throw new DomainError(400, "unknown_license", `授权 ${licenseId} 不存在`);
    }
    return licenseId;
  });
  if (kind === "image" && licenses.length === 0) {
    throw new DomainError(400, "image_requires_license", "图片资产必须绑定授权");
  }
  return { facts, licenses };
}

// ---------- 分域确认 ----------
export function confirmAssetVersion(state, actor, assetId, versionNumber, domain) {
  const asset = mustAsset(state, assetId);
  const version = asset.versions.find((v) => v.version === versionNumber);
  if (!version) throw new DomainError(404, "asset_version_not_found", `资产 ${assetId} 没有版本 ${versionNumber}`);
  if (version.status === "withdrawn") throw new DomainError(409, "version_withdrawn", "已撤回的版本不能再确认");
  const required = KIND_DOMAINS[asset.kind];
  if (!required.includes(domain)) {
    throw new DomainError(400, "invalid_domain", `资产类型 ${asset.kind} 不需要 ${domain} 域的确认`);
  }
  if (!domainsForRole(actor.role).includes(domain)) {
    throw new DomainError(403, "domain_not_allowed", `角色 ${actor.role} 不能确认 ${domain} 域；各角色只确认自己负责的部分`);
  }
  const duplicated = state.confirmations.some(
    (c) => c.asset_id === assetId && c.version === versionNumber && c.domain === domain,
  );
  if (duplicated) throw new DomainError(409, "already_confirmed", "该版本此域已确认");
  const confirmation = {
    id: nextId(state, "conf"),
    asset_id: assetId,
    version: versionNumber,
    domain,
    actor_id: actor.id,
    created_at: state.now(),
  };
  state.confirmations.push(confirmation);
  recordEvent(state, "confirmation_added", {
    asset_id: assetId,
    object_id: asset.object_id,
    kind: asset.kind,
    version: versionNumber,
    domain,
    actor_id: actor.id,
  });
  return confirmation;
}

// ---------- 版本状态评估 ----------
// cleared: 分域确认齐全且全部依赖仍然有效，可以发布
// unconfirmed: 缺少分域确认
// stale: 依赖的事实版本已被更新版本取代，需要重发
// invalid: 依赖被撤回或版本被撤回，公开端必须立即停止展示
export function assessAssetVersion(state, asset, version) {
  const invalidReasons = [];
  const staleReasons = [];
  if (version.status === "withdrawn") invalidReasons.push("该资产版本已被撤回");
  for (const dep of version.deps.facts) {
    const fact = state.facts.get(dep.fact_id);
    const fv = fact ? getFactVersion(fact, dep.version) : null;
    if (!fact || !fv) {
      invalidReasons.push(`依赖的事实 ${dep.fact_id}@${dep.version} 不存在`);
    } else if (fv.status === "withdrawn") {
      invalidReasons.push(`依赖的事实「${fact.key}」版本 ${dep.version} 已撤回`);
    } else if (fv.status === "superseded") {
      const current = currentFactVersion(fact);
      if (current) {
        staleReasons.push(`依赖的事实「${fact.key}」版本 ${dep.version} 已被版本 ${current.version} 取代`);
      } else {
        // 事实已没有任何有效版本（当前版本也被撤回），依赖内容必须停止展示
        invalidReasons.push(`依赖的事实「${fact.key}」当前没有有效版本`);
      }
    }
  }
  for (const licenseId of version.deps.licenses) {
    const license = state.licenses.get(licenseId);
    if (!license) invalidReasons.push(`依赖的授权 ${licenseId} 不存在`);
    else if (license.status === "withdrawn") invalidReasons.push(`依赖的授权「${license.title}」已撤回`);
  }
  const required = KIND_DOMAINS[asset.kind];
  const confirmed = new Set(
    state.confirmations.filter((c) => c.asset_id === asset.id && c.version === version.version).map((c) => c.domain),
  );
  const missingConfirmations = required.filter((d) => !confirmed.has(d));
  let status;
  if (invalidReasons.length > 0) status = "invalid";
  else if (staleReasons.length > 0) status = "stale";
  else if (missingConfirmations.length > 0) status = "unconfirmed";
  else status = "cleared";
  return {
    status,
    reasons: [...invalidReasons, ...staleReasons],
    missing_confirmations: missingConfirmations,
  };
}

// ---------- 查询辅助 ----------
export function mustObject(state, objectId) {
  const object = state.objects.get(objectId);
  if (!object) throw new DomainError(404, "object_not_found", `对象 ${objectId} 不存在`);
  return object;
}

export function mustFact(state, factId) {
  const fact = state.facts.get(factId);
  if (!fact) throw new DomainError(404, "fact_not_found", `事实 ${factId} 不存在`);
  return fact;
}

export function mustAsset(state, assetId) {
  const asset = state.assets.get(assetId);
  if (!asset) throw new DomainError(404, "asset_not_found", `资产 ${assetId} 不存在`);
  return asset;
}

export function assetView(state, asset) {
  return {
    id: asset.id,
    object_id: asset.object_id,
    kind: asset.kind,
    versions: asset.versions.map((v) => ({
      version: v.version,
      body: v.body,
      deps: v.deps,
      status: v.status,
      created_at: v.created_at,
      assessment: assessAssetVersion(state, asset, v),
      confirmations: state.confirmations
        .filter((c) => c.asset_id === asset.id && c.version === v.version)
        .map((c) => ({ domain: c.domain, actor_id: c.actor_id, created_at: c.created_at })),
    })),
  };
}
