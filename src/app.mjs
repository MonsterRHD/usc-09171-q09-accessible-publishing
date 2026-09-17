import http from "node:http";
import { createStore } from "./store.mjs";
import { createRouter } from "./http.mjs";
import {
  DomainError,
  KIND_DOMAINS,
  addAssetVersion,
  addFactVersion,
  assetView,
  confirmAssetVersion,
  createAsset,
  createFact,
  createLicense,
  createObject,
  mustAsset,
  mustFact,
  withdrawAssetVersion,
  withdrawFactVersion,
  withdrawLicense,
} from "./domain.mjs";
import {
  attemptDelivery,
  deliveryView,
  ingestReceipt,
  publicView,
  publicationView,
  publish,
} from "./publications.mjs";
import { impactOfChange, republishScope, takedownView } from "./impact.mjs";
import { backfillTakedown, createTakedown } from "./emergency.mjs";
import {
  correctionView,
  createCorrection,
  getCorrectionContact,
  resolveCorrection,
} from "./corrections.mjs";
import { channelTimeline, displayedAt } from "./audit.mjs";

const STAFF = ["editor", "curator", "accessibility", "copyright", "correction-handler", "auditor", "admin"];

const DOMAIN_ROLES = { curatorial: "curator", accessibility: "accessibility", rights: "copyright" };

function requireRole(actor, roles) {
  if (!roles.includes(actor.role)) {
    throw new DomainError(403, "forbidden", `角色 ${actor.role} 无权执行此操作`);
  }
}

export function createServer(options = {}) {
  const state = createStore({ now: options.now });
  const router = createRouter();
  const ok = (body, status = 200) => ({ status, body });

  router.add("GET", "/health", () => ok({ status: "ok", service: "accessible-publishing" }));

  // ---------- 对象 ----------
  router.add("POST", "/objects", ({ body, actor }) => {
    requireRole(actor, ["curator", "admin"]);
    return ok(createObject(state, actor, body), 201);
  });
  router.add("GET", "/objects", ({ actor }) => {
    requireRole(actor, STAFF);
    return ok([...state.objects.values()]);
  });

  // ---------- 事实（跨渠道共用，按版本管理） ----------
  router.add("POST", "/facts", ({ body, actor }) => {
    requireRole(actor, ["curator", "admin"]);
    return ok(createFact(state, actor, body), 201);
  });
  router.add("GET", "/facts/:id", ({ params, actor }) => {
    requireRole(actor, STAFF);
    return ok(mustFact(state, params.id));
  });
  router.add("POST", "/facts/:id/versions", ({ params, body, actor }) => {
    requireRole(actor, ["curator", "admin"]);
    const { fact, version, superseded } = addFactVersion(state, actor, params.id, body.value);
    // 精确算出被取代版本影响到的渠道内容
    const impact = superseded ? impactOfChange(state, { fact_id: fact.id, version: superseded.version }) : null;
    return ok({ fact, version, impact }, 201);
  });
  router.add("POST", "/facts/:id/withdraw", ({ params, body, actor }) => {
    requireRole(actor, ["curator", "admin"]);
    const fact = mustFact(state, params.id);
    const current = fact.versions.find((v) => v.status === "current");
    const versionNumber = body.version ?? (current ? current.version : undefined);
    const { version } = withdrawFactVersion(state, actor, params.id, versionNumber);
    const impact = impactOfChange(state, { fact_id: fact.id, version: version.version });
    return ok({ fact, version, impact });
  });

  // ---------- 授权 ----------
  router.add("POST", "/licenses", ({ body, actor }) => {
    requireRole(actor, ["copyright", "admin"]);
    return ok(createLicense(state, actor, body), 201);
  });
  router.add("POST", "/licenses/:id/withdraw", ({ params, actor }) => {
    requireRole(actor, ["copyright", "admin"]);
    const license = withdrawLicense(state, actor, params.id);
    const impact = impactOfChange(state, { license_id: license.id });
    return ok({ license, impact });
  });

  // ---------- 语义资产与分域确认 ----------
  router.add("POST", "/assets", ({ body, actor }) => {
    requireRole(actor, ["editor", "curator", "accessibility", "copyright", "admin"]);
    return ok(createAsset(state, actor, body), 201);
  });
  router.add("GET", "/assets/:id", ({ params, actor }) => {
    requireRole(actor, STAFF);
    return ok(assetView(state, mustAsset(state, params.id)));
  });
  router.add("POST", "/assets/:id/versions", ({ params, body, actor }) => {
    requireRole(actor, ["editor", "curator", "accessibility", "copyright", "admin"]);
    return ok(addAssetVersion(state, actor, params.id, body), 201);
  });
  router.add("POST", "/assets/:id/versions/:version/withdraw", ({ params, actor }) => {
    const asset = mustAsset(state, params.id);
    // 撤回资产版本需要该资产类型所属域的角色（或 admin）
    const allowed = ["admin", ...KIND_DOMAINS[asset.kind].map((domain) => DOMAIN_ROLES[domain])];
    requireRole(actor, allowed);
    return ok(withdrawAssetVersion(state, actor, params.id, Number(params.version)));
  });
  router.add("POST", "/assets/:id/versions/:version/confirmations", ({ params, body, actor }) => {
    return ok(confirmAssetVersion(state, actor, params.id, Number(params.version), body.domain), 201);
  });

  // ---------- 发布与投递 ----------
  router.add("POST", "/publications", ({ body, actor }) => {
    requireRole(actor, ["editor", "admin"]);
    const publication = publish(state, actor, body);
    return ok(publicationView(state, publication), 201);
  });
  router.add("GET", "/publications/:id", ({ params, actor }) => {
    requireRole(actor, STAFF);
    const publication = state.publications.get(params.id);
    if (!publication) throw new DomainError(404, "publication_not_found", `内容包 ${params.id} 不存在`);
    return ok(publicationView(state, publication));
  });
  router.add("POST", "/deliveries/:id/attempts", ({ params, body, actor }) => {
    requireRole(actor, ["editor", "admin"]);
    return ok(deliveryView(attemptDelivery(state, params.id, body)));
  });

  // ---------- 渠道回执（幂等） ----------
  router.add("POST", "/channels/:channel/receipts", ({ params, body }) => {
    const result = ingestReceipt(state, params.channel, body);
    return ok(result, result.duplicate ? 200 : 201);
  });

  // ---------- 公开端 ----------
  router.add("GET", "/public/channels/:channel/objects/:object", ({ params }) => {
    return ok(publicView(state, params.channel, params.object));
  });

  // ---------- 影响计算与待重发范围 ----------
  router.add("POST", "/impact/compute", ({ body, actor }) => {
    requireRole(actor, ["curator", "copyright", "editor", "admin"]);
    if (!body.fact_id && !body.license_id) {
      throw new DomainError(400, "invalid_change", "需要指定 fact_id（可带 version）或 license_id");
    }
    const change = body.fact_id
      ? { fact_id: body.fact_id, version: body.version ?? currentVersionOf(state, body.fact_id) }
      : { license_id: body.license_id };
    return ok(impactOfChange(state, change));
  });
  router.add("GET", "/republish-scope", ({ actor }) => {
    requireRole(actor, ["editor", "admin"]);
    return ok(republishScope(state));
  });

  // ---------- 紧急纠错 ----------
  router.add("POST", "/emergency-takedowns", ({ body, actor }) => {
    requireRole(actor, ["editor", "admin"]);
    return ok(takedownView(createTakedown(state, actor, body)), 201);
  });
  router.add("GET", "/emergency-takedowns", ({ query, actor }) => {
    requireRole(actor, STAFF);
    const status = query.get("status");
    const list = [...state.takedowns.values()].filter((t) => !status || t.status === status);
    return ok(list.map(takedownView));
  });
  router.add("PATCH", "/emergency-takedowns/:id", ({ params, body, actor }) => {
    requireRole(actor, ["editor", "admin"]);
    return ok(takedownView(backfillTakedown(state, actor, params.id, body)));
  });

  // ---------- 观众纠错 ----------
  router.add("POST", "/corrections", ({ body, actor }) => {
    return ok(correctionView(createCorrection(state, actor, body)), 201);
  });
  router.add("GET", "/corrections", ({ actor }) => {
    requireRole(actor, STAFF);
    return ok([...state.corrections.values()].map(correctionView));
  });
  router.add("GET", "/corrections/:id", ({ params, actor }) => {
    requireRole(actor, STAFF);
    const correction = state.corrections.get(params.id);
    if (!correction) throw new DomainError(404, "correction_not_found", `纠错 ${params.id} 不存在`);
    return ok(correctionView(correction));
  });
  router.add("GET", "/corrections/:id/contact", ({ params, actor }) => {
    requireRole(actor, ["correction-handler", "admin"]);
    return ok(getCorrectionContact(state, params.id));
  });
  router.add("POST", "/corrections/:id/resolve", ({ params, body, actor }) => {
    requireRole(actor, ["correction-handler", "admin"]);
    return ok(correctionView(resolveCorrection(state, actor, params.id, body)));
  });

  // ---------- 审计 ----------
  router.add("GET", "/audit/displayed", ({ query, actor }) => {
    requireRole(actor, ["auditor", "admin"]);
    return ok(displayedAt(state, query.get("at") ?? undefined));
  });
  router.add("GET", "/audit/channels/:channel/timeline", ({ params, query, actor }) => {
    requireRole(actor, ["auditor", "admin"]);
    return ok(channelTimeline(state, params.channel, query.get("object_id") ?? undefined));
  });

  const server = http.createServer((request, response) => router.handle(request, response));
  server.state = state; // 供测试与运维检查
  return server;
}

function currentVersionOf(state, factId) {
  const fact = mustFact(state, factId);
  const current = fact.versions.find((v) => v.status === "current");
  return current ? current.version : fact.versions[fact.versions.length - 1].version;
}
