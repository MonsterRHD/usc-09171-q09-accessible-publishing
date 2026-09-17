import crypto from "node:crypto";
import { contentHash, packageDigest } from "./digest.mjs";
import { badRequest, conflict, forbidden, notFound } from "./errors.mjs";
import { buildProjection } from "./projection.mjs";
import {
  CHANNEL_PRESENTS_IMAGES,
  CHANNEL_PROFILES,
  COMPONENT_RESPONSIBLE_ROLE,
  COMPONENT_TYPES,
  ROLES,
} from "./roles.mjs";

const ALL_CHANNELS = Object.keys(CHANNEL_PROFILES);

function requireRole(actor, roles, action) {
  if (!actor || !roles.includes(actor.role)) {
    throw forbidden(`角色 ${actor?.role ?? "未知"} 不能执行${action}`, { required: roles });
  }
}

// 无障碍语义发布服务。所有写操作都落为事件，读操作由投影即时归约，
// 因此任意历史时间点的渠道真实展示状态都可以重放还原。
export class PublishingService {
  constructor(store) {
    this.store = store;
  }

  snapshot({ at } = {}) {
    return buildProjection(this.store.all(), { at });
  }

  #getObject(state, objectId) {
    const obj = state.objects[objectId];
    if (!obj) throw notFound(`资料对象 ${objectId} 不存在`);
    return obj;
  }

  // ---- 对象身份 -------------------------------------------------------
  // 原件与可触摸复制品必须是不同对象，身份一经建立不可改写，
  // 从根上杜绝“复制品描述传播到原件”。
  registerObject(actor, { objectId, kind, label }) {
    requireRole(actor, [ROLES.CURATOR, ROLES.COORDINATOR], "登记资料对象");
    if (!["original", "touch-replica"].includes(kind)) {
      throw badRequest("kind 必须是 original 或 touch-replica");
    }
    const state = this.snapshot();
    if (state.objects[objectId]) throw conflict(`对象 ${objectId} 已登记`);
    return this.store.append(
      "ObjectRegistered",
      { objectId, kind, label },
      actor
    );
  }

  // ---- 核心事实 -------------------------------------------------------
  recordFact(actor, { objectId, body, basis, changeNote }) {
    requireRole(actor, [ROLES.CURATOR], "记录核心事实");
    if (!body || typeof body !== "object") throw badRequest("事实载荷 body 缺失");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    // 版本号按该对象历史事实的最大序号递增；撤回后补记新事实也不会复用旧号。
    const next =
      Object.keys(state.objects[objectId].facts).reduce(
        (max, version) => Math.max(max, Number(version.slice(1))),
        0
      ) + 1;
    const version = `f${next}`;
    const hash = contentHash(body);
    return this.store.append(
      "FactRecorded",
      {
        objectId,
        version,
        body,
        factsHash: hash,
        basis: basis ?? null,
        changeNote: changeNote ?? null,
        supersedes: state.objects[objectId].currentFactVersion,
      },
      actor
    );
  }

  // 撤回事实（例如已撤回的年代判断）。撤回后基于该事实的全部组件立即失去发布基础。
  retractFact(actor, { objectId, version, reason }) {
    requireRole(actor, [ROLES.CURATOR], "撤回核心事实");
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);
    const target = version ?? obj.currentFactVersion;
    if (!obj.facts[target]) throw notFound(`事实版本 ${target} 不存在`);
    if (obj.facts[target].withdrawn) throw conflict(`事实版本 ${target} 已经撤回`);
    return this.store.append("FactRetracted", { objectId, version: target, reason }, actor);
  }

  // ---- 语义组件（术语/替代文本/触觉提示/易读说明/语音脚本）------------
  draftComponent(actor, { objectId, componentType, body }) {
    requireRole(
      actor,
      [ROLES.EDITOR, ROLES.COORDINATOR, ROLES.CURATOR, ROLES.ACCESSIBILITY],
      "起草内容组件"
    );
    if (!COMPONENT_TYPES.includes(componentType)) {
      throw badRequest(`未知组件类型 ${componentType}`, { allowed: COMPONENT_TYPES });
    }
    if (body == null || typeof body !== "object" || Object.keys(body).length === 0) {
      throw badRequest("组件正文 body 缺失");
    }
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);
    if (!obj.currentFactVersion) {
      throw conflict("对象尚无有效核心事实，不能起草可发布组件");
    }
    const family = obj.components[componentType] ?? { revisions: {} };
    const version = `c${Object.keys(family.revisions).length + 1}`;
    return this.store.append(
      "ComponentDrafted",
      {
        objectId,
        componentType,
        version,
        body,
        contentHash: contentHash(body),
        basedOnFactVersion: obj.currentFactVersion,
        basedOnFactsHash: obj.factsHash,
      },
      actor
    );
  }

  // 分域确认：馆员只确认术语，无障碍顾问只确认四类适配内容，版权人员只管授权。
  confirmComponent(actor, { objectId, componentType, version }) {
    const requiredRole = COMPONENT_RESPONSIBLE_ROLE[componentType];
    requireRole(actor, [requiredRole], `确认 ${componentType}`);
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);
    const revision = obj.components[componentType]?.revisions[version];
    if (!revision) throw notFound(`组件 ${componentType}@${version} 不存在`);
    if (revision.confirmations[requiredRole]) {
      throw conflict("该版本已由本责任域确认");
    }
    // 基于已撤回事实的版本拒绝确认：旧草稿不能借一次新确认复活。
    const fact = obj.facts[revision.basedOnFactVersion];
    if (!fact || fact.withdrawn) {
      throw conflict("该组件基于的事实版本已撤回，不能确认；请依据当前事实重新起草");
    }
    return this.store.append(
      "ComponentConfirmed",
      { objectId, componentType, version, role: requiredRole },
      actor
    );
  }

  // ---- 图片授权 -------------------------------------------------------
  grantImageLicense(actor, { objectId, imageId, scope }) {
    requireRole(actor, [ROLES.COPYRIGHT], "授予图片许可");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    return this.store.append(
      "ImageLicenseGranted",
      { objectId, imageId, scope: scope ?? { channels: ALL_CHANNELS } },
      actor
    );
  }

  withdrawImageLicense(actor, { objectId, imageId, reason }) {
    requireRole(actor, [ROLES.COPYRIGHT], "撤回图片许可");
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);
    const img = obj.images[imageId];
    if (!img) throw notFound(`图片 ${imageId} 无授权记录`);
    if (img.status === "withdrawn") throw conflict(`图片 ${imageId} 已撤回`);
    return this.store.append("ImageLicenseWithdrawn", { objectId, imageId, reason }, actor);
  }

  // ---- 内容包构建与门禁 ----------------------------------------------
  // 返回 {digest, blocking}。blocking 非空时不产生 PackageBuilt。
  buildPackage(actor, { objectId, imageIds }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR], "构建内容包");
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);
    const blocking = [];

    if (!obj.currentFactVersion) {
      blocking.push({ scope: "fact", reason: "缺少有效核心事实（可能已撤回）" });
    }

    const picked = {};
    for (const type of COMPONENT_TYPES) {
      const family = obj.components[type];
      // 只允许选用：基于当前事实版本 + 已由责任域确认的最高版本。
      // 旧审核（针对旧事实的确认）不构成继续发布的理由。
      const candidates = Object.values(family?.revisions ?? {})
        .filter(
          (rev) =>
            rev.basedOnFactVersion === obj.currentFactVersion &&
            rev.confirmations[COMPONENT_RESPONSIBLE_ROLE[type]]
        )
        .sort((a, b) => (a.version < b.version ? 1 : -1));
      if (candidates.length === 0) {
        blocking.push({
          scope: type,
          reason: `缺少基于事实 ${obj.currentFactVersion ?? "-"} 且经 ${
            COMPONENT_RESPONSIBLE_ROLE[type]
          } 确认的版本`,
        });
      } else {
        picked[type] = candidates[0];
      }
    }

    const wantedImages = imageIds ?? Object.keys(obj.images);
    const images = [];
    for (const imageId of wantedImages) {
      const img = obj.images[imageId];
      if (!img || img.status !== "granted") {
        blocking.push({ scope: "image-license", imageId, reason: "图片未获得有效授权" });
        continue;
      }
      images.push({ imageId, status: "granted", channels: img.scope.channels });
    }

    if (blocking.length > 0) return { digest: null, blocking };

    const snapshot = {
      objectId,
      kind: obj.kind,
      label: obj.label,
      factVersion: obj.currentFactVersion,
      factsHash: obj.factsHash,
      components: Object.fromEntries(
        COMPONENT_TYPES.map((type) => [
          type,
          { version: picked[type].version, contentHash: picked[type].contentHash },
        ])
      ),
      images,
    };
    const digest = packageDigest(snapshot);
    if (!state.packages[digest]) {
      this.store.append("PackageBuilt", { digest, ...snapshot }, actor);
    }
    return { digest, blocking: [], reused: Boolean(state.packages[digest]) };
  }

  // ---- 渠道投递 -------------------------------------------------------
  dispatchPackage(actor, { objectId, channels, digest }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR], "向渠道投递内容包");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    const targetChannels = channels ?? ALL_CHANNELS;
    for (const channel of targetChannels) {
      if (!CHANNEL_PROFILES[channel]) throw badRequest(`未知渠道 ${channel}`);
    }

    let chosen = digest;
    if (!chosen) {
      // 该对象最近构建的内容包。
      chosen = Object.values(state.packages)
        .filter((pkg) => pkg.objectId === objectId)
        .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))[0]?.digest;
    }
    const pkg = chosen ? state.packages[chosen] : null;
    if (!pkg) throw conflict("没有可投递的已通过门禁内容包，请先 buildPackage");
    // 身份隔离：禁止把甲对象（如复制品）的内容包以乙对象（如原件）名义投递。
    if (pkg.objectId !== objectId) {
      throw badRequest("内容包不属于该对象，禁止跨对象投递", {
        packageObject: pkg.objectId,
        requestedObject: objectId,
      });
    }

    const dispatchIds = [];
    for (const channel of targetChannels) {
      const dispatchId = `d-${crypto.randomUUID()}`;
      this.store.append(
        "ChannelDispatchCreated",
        {
          dispatchId,
          objectId,
          channel,
          digest: chosen,
          factVersion: pkg.factVersion,
          components: pkg.components,
        },
        actor
      );
      dispatchIds.push(dispatchId);
    }
    return { digest: chosen, dispatchIds };
  }

  retryDelivery(actor, { dispatchId }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR], "重试渠道投递");
    const state = this.snapshot();
    const dispatch = state.dispatches[dispatchId];
    if (!dispatch) throw notFound(`投递 ${dispatchId} 不存在`);
    if (["displayed", "superseded"].includes(dispatch.state)) {
      throw conflict(`投递状态为 ${dispatch.state}，无需重试`);
    }
    return this.store.append(
      "DeliveryRetried",
      { dispatchId, attempt: dispatch.attempts + 1 },
      actor
    );
  }

  // ---- 渠道回执（accepted ≠ displayed，允许重复投递）-----------------
  recordReceipt(actor, raw) {
    // 兼容既有渠道回执样例的下划线字段名。
    const receipt = {
      receiptId: raw.receipt_id ?? raw.receiptId,
      channel: raw.channel,
      digest: raw.package_digest ?? raw.digest,
      status: raw.status,
      receivedAt: raw.received_at ?? raw.receivedAt ?? null,
      displayedAt: raw.displayed_at ?? raw.displayedAt ?? null,
    };
    if (!receipt.receiptId || !receipt.channel || !receipt.digest || !receipt.status) {
      throw badRequest("回执缺少 receiptId/channel/package_digest/status 之一");
    }
    if (!["accepted", "displayed", "failed"].includes(receipt.status)) {
      throw badRequest(`未知回执状态 ${receipt.status}`);
    }
    if (receipt.status === "displayed" && !receipt.displayedAt) {
      throw badRequest("displayed 回执必须带 displayed_at");
    }
    const state = this.snapshot();
    const duplicate = Boolean(state.receipts[receipt.receiptId]);
    this.store.append("ChannelReceiptRecorded", receipt, actor ?? { id: "channel", role: "system" });
    return { receiptId: receipt.receiptId, duplicate };
  }

  // ---- 紧急纠错：先撤下，后补齐 ---------------------------------------
  emergencyPull(actor, { objectId, channels, harmfulDescription, correctionId }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR], "紧急撤下");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    const targetChannels = channels ?? ALL_CHANNELS;
    for (const channel of targetChannels) {
      if (!CHANNEL_PROFILES[channel]) throw badRequest(`未知渠道 ${channel}`);
    }
    const id = correctionId ?? `corr-${crypto.randomUUID()}`;
    if (state.corrections[id]) throw conflict(`纠错单 ${id} 已存在`);
    this.store.append(
      "CorrectionFiled",
      {
        correctionId: id,
        objectId,
        channels: targetChannels,
        description: harmfulDescription ?? null,
        pulled: true,
      },
      actor
    );
    this.store.append(
      "ContentPulled",
      { correctionId: id, objectId, channels: targetChannels, reason: null },
      actor
    );
    return { correctionId: id, channels: targetChannels };
  }

  // 观众纠错入口：联系方式与处理单分开存放，普通列表永远看不到。
  fileCorrection(actor, input) {
    const { objectId, channels, description, name, contact } = input;
    if (!objectId || !description) throw badRequest("纠错至少需要 objectId 与 description");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    const targetChannels = (channels ?? []).filter((channel) => CHANNEL_PROFILES[channel]);
    const id = `corr-${crypto.randomUUID()}`;
    this.store.append(
      "CorrectionFiled",
      { correctionId: id, objectId, channels: targetChannels, description, pulled: false },
      actor ?? { id: "audience", role: "viewer" }
    );
    // 只保留处理所需信息：没有提供联系方式就不留存任何身份信息。
    if (name || contact) {
      this.store.append(
        "CorrectionContactStored",
        { correctionId: id, name: name ?? null, contact: contact ?? null },
        actor ?? { id: "audience", role: "viewer" }
      );
    }
    return { correctionId: id };
  }

  listCorrections(actor) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR], "查看纠错单");
    return Object.values(this.snapshot().corrections).sort((a, b) =>
      a.filedAt < b.filedAt ? 1 : -1
    );
  }

  // 联系方式仅限协调处理角色按需读取，普通编辑无法访问。
  readCorrectionContact(actor, { correctionId }) {
    requireRole(actor, [ROLES.COORDINATOR], "读取纠错联系方式");
    const state = this.snapshot();
    if (!state.corrections[correctionId]) throw notFound(`纠错单 ${correctionId} 不存在`);
    const contact = state.contacts[correctionId];
    if (!contact) return { correctionId, contact: null };
    return { correctionId, ...contact };
  }

  // 撤下之后必须补齐：原因、替代版本、批准人，三者缺一不可。
  resolveCorrection(actor, { correctionId, reason, replacementDispatchId, approver }) {
    requireRole(actor, [ROLES.COORDINATOR], "办结紧急纠错");
    const state = this.snapshot();
    const correction = state.corrections[correctionId];
    if (!correction) throw notFound(`纠错单 ${correctionId} 不存在`);
    if (correction.status === "resolved") throw conflict("纠错单已办结");
    const missing = [];
    if (!reason) missing.push("reason");
    if (!replacementDispatchId) missing.push("replacementDispatchId");
    if (!approver?.id || !approver?.role) missing.push("approver");
    if (missing.length) throw badRequest("办结缺少必填项", { missing });
    const replacement = state.dispatches[replacementDispatchId];
    if (!replacement || replacement.objectId !== correction.objectId) {
      throw badRequest("替代投递不存在或不属于同一对象");
    }
    if (!correction.channels.includes(replacement.channel)) {
      throw badRequest("替代版本必须投递给本次撤下的渠道之一", {
        pulledChannels: correction.channels,
        replacementChannel: replacement.channel,
      });
    }
    if (!Object.values(ROLES).includes(approver.role)) {
      throw badRequest(`未知批准角色 ${approver.role}`);
    }
    return this.store.append(
      "CorrectionResolved",
      {
        correctionId,
        reason,
        replacementDispatchId,
        approverId: approver.id,
        approverRole: approver.role,
      },
      actor
    );
  }

  // ---- 影响分析 / 待重发范围 ------------------------------------------
  // 精确计算事实或授权变化后，哪些渠道的在展内容已经失效、哪些投递还在途。
  resendScope(actor, { objectId }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR, ROLES.CURATOR], "查询待重发范围");
    const state = this.snapshot();
    const obj = this.#getObject(state, objectId);

    // 当前在门禁意义下仍然有效的最新内容包（无则为 null，说明事实撤回后暂无可发版本）。
    const currentValid = latestValidPackage(state, obj);
    const blocking = currentValid ? [] : packageBlockers(state, obj);

    const result = { objectId, currentDigest: currentValid?.digest ?? null, blocking, channels: {} };
    for (const channel of ALL_CHANNELS) {
      const ch = state.channels[channel];
      const dispatches = Object.values(state.dispatches)
        .filter((d) => d.objectId === objectId && d.channel === channel)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const last = dispatches[0] ?? null;
      const displayed = ch?.displayed?.[objectId] ?? null;
      const pulledOpen =
        ch?.pulls.some(
          (pull) => pull.objectId === objectId && pull.clearedAt === null
        ) ?? false;

      let status;
      const reasons = [];
      if (pulledOpen) {
        status = "pulled";
      } else if (!last) {
        status = "never-dispatched";
      } else if (displayed) {
        const stillValid = isDigestValidFor(state, obj, displayed.digest, channel);
        if (stillValid) {
          status = "displayed-current";
        } else if (
          last &&
          last.digest !== displayed.digest &&
          ["awaiting-receipt", "accepted-awaiting-display"].includes(last.state)
        ) {
          // 旧版本仍在展，但替代内容包已经发出，只等渠道展示回执。
          status = "resend-in-flight";
          reasons.push(...staleReasons(state, obj, displayed.digest, channel));
          reasons.push(
            last.state === "accepted-awaiting-display"
              ? "替代包渠道已收到、尚未展示"
              : "替代包已投递、等待渠道回执"
          );
        } else {
          status = "displayed-stale";
          reasons.push(...staleReasons(state, obj, displayed.digest, channel));
        }
      } else if (last.state === "displayed") {
        // 该投递曾展示，但此对象当前不在该渠道在展集合中（已被撤下或替换）。
        status = "not-on-display";
      } else if (last.state === "failed") {
        status = "delivery-failed";
        reasons.push("渠道回执 failed，需要重试");
      } else if (last.state === "superseded") {
        status = "superseded";
      } else {
        // 在途包也要按当前事实与授权重新校验：包投出后事实或许可已变化时，
        // 不能再干等它展示，必须构建新包重发。
        const inFlightValid = isDigestValidFor(state, obj, last.digest, channel);
        if (inFlightValid) {
          status = "in-flight";
          reasons.push(
            last.state === "accepted-awaiting-display"
              ? "渠道已收到内容包但尚未展示（accepted 不等于 displayed）"
              : "尚未收到渠道回执"
          );
        } else {
          status = "dispatch-invalidated";
          reasons.push(...staleReasons(state, obj, last.digest, channel));
          reasons.push("在途内容包已失效，即使渠道随后展示也必须以新版本替换");
        }
      }

      result.channels[channel] = {
        status,
        needsResend:
          status === "displayed-stale" ||
          status === "delivery-failed" ||
          status === "pulled" ||
          status === "dispatch-invalidated",
        awaitingDisplay: status === "in-flight" || status === "resend-in-flight",
        displayedDigest: displayed?.digest ?? null,
        displayedAt: displayed?.displayedAt ?? null,
        lastDispatchId: last?.dispatchId ?? null,
        lastDispatchState: last?.state ?? null,
        attempts: last?.attempts ?? 0,
        reasons,
      };
    }
    return result;
  }

  // 投递实况：每个渠道收到的包摘要、尝试次数、回执与最终状态，反映部分上线。
  listDispatches(actor, { objectId }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR, ROLES.CURATOR], "查看投递实况");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    return Object.values(state.dispatches)
      .filter((d) => d.objectId === objectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((d) => ({
        dispatchId: d.dispatchId,
        channel: d.channel,
        digest: d.digest,
        factVersion: d.factVersion,
        state: d.state,
        attempts: d.attempts,
        lastAttemptAt: d.lastAttemptAt,
        receipts: d.receipts,
        createdAt: d.createdAt,
      }));
  }

  // ---- 审计：还原任意时间点各渠道真正展示过的版本 ---------------------
  channelTimeline(actor, { channel }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR, ROLES.CURATOR, ROLES.COPYRIGHT], "查看渠道时间线");
    const state = this.snapshot();
    const ch = state.channels[channel];
    if (!ch) throw notFound(`渠道 ${channel} 尚无记录`);
    return ch.history;
  }

  displayAt(actor, { channel, at }) {
    requireRole(actor, [ROLES.EDITOR, ROLES.COORDINATOR, ROLES.CURATOR, ROLES.COPYRIGHT], "还原历史展示版本");
    const state = this.snapshot({ at });
    // 历史时间点渠道可能同时展示多个对象；如未指定对象，返回全部。
    const shown = state.channels[channel]?.displayed ?? {};
    const entries = Object.entries(shown);
    if (entries.length === 0) return { channel, at, displayed: null };
    const displayed = Object.fromEntries(
      entries.map(([objectId, entry]) => {
        const pkg = state.packages[entry.digest];
        return [
          objectId,
          {
            objectId,
            digest: entry.digest,
            displayedAt: entry.displayedAt,
            factVersion: pkg?.factVersion ?? null,
            components: pkg?.components ?? null,
            images: pkg?.images ?? null,
          },
        ];
      })
    );
    return { channel, at, displayed };
  }

  objectAuditTrail(actor, { objectId }) {
    requireRole(actor, [ROLES.COORDINATOR, ROLES.CURATOR], "查看对象完整审计轨迹");
    const state = this.snapshot();
    this.#getObject(state, objectId);
    return this.store.all().filter((event) => event.payload?.objectId === objectId);
  }
}

// ---- 影响分析辅助函数 --------------------------------------------------
function latestValidPackage(state, obj) {
  // 事实缺失/撤回时任何包都不再有效。
  if (!obj.currentFactVersion) return null;
  return (
    Object.values(state.packages)
      .filter((pkg) => pkg.objectId === obj.id && isPackageValid(state, obj, pkg))
      .sort((a, b) => (a.builtAt < b.builtAt ? 1 : -1))[0] ?? null
  );
}

function isPackageValid(state, obj, pkg) {
  if (pkg.factsHash !== obj.factsHash) return false;
  if (!obj.facts[pkg.factVersion] || obj.facts[pkg.factVersion].withdrawn) return false;
  // 许可撤回使包含该图片的包失效。
  for (const entry of pkg.images ?? []) {
    const img = obj.images[entry.imageId];
    if (!img || img.status !== "granted") return false;
  }
  return true;
}

// 对特定渠道：仅当渠道呈现图片、授权范围覆盖该渠道、且图片仍在授权期内才计入有效性。
function isDigestValidFor(state, obj, digest, channel) {
  const pkg = state.packages[digest];
  if (!pkg) return false;
  if (pkg.factsHash !== obj.factsHash) return false;
  if (!obj.facts[pkg.factVersion] || obj.facts[pkg.factVersion].withdrawn) return false;
  if (!CHANNEL_PRESENTS_IMAGES[channel]) return true;
  for (const entry of pkg.images ?? []) {
    const covers = !entry.channels || entry.channels.includes(channel);
    if (covers) {
      const img = obj.images[entry.imageId];
      if (!img || img.status !== "granted") return false;
    }
  }
  return true;
}

function staleReasons(state, obj, digest, channel) {
  const pkg = state.packages[digest];
  const reasons = [];
  if (!pkg) return ["展示中的内容包无构建记录"];
  if (pkg.factsHash !== obj.factsHash || obj.facts[pkg.factVersion]?.withdrawn) {
    reasons.push("核心事实已变化或被撤回");
  }
  // 不呈现图片的渠道（语音导览等）不受图片许可状态影响。
  if (CHANNEL_PRESENTS_IMAGES[channel]) {
    for (const entry of pkg.images ?? []) {
      if (entry.channels && !entry.channels.includes(channel)) continue;
      const img = obj.images[entry.imageId];
      if (!img || img.status !== "granted") reasons.push(`图片 ${entry.imageId} 许可已撤回`);
    }
  }
  return reasons;
}

function packageBlockers(state, obj) {
  const blocking = [];
  if (!obj.currentFactVersion) blocking.push({ scope: "fact", reason: "缺少有效核心事实（可能已撤回）" });
  for (const type of COMPONENT_TYPES) {
    const ok = Object.values(obj.components[type]?.revisions ?? {}).some(
      (rev) =>
        rev.basedOnFactVersion === obj.currentFactVersion &&
        rev.confirmations[COMPONENT_RESPONSIBLE_ROLE[type]]
    );
    if (!ok) blocking.push({ scope: type, reason: "组件需依据当前事实重新起草并经责任域确认" });
  }
  return blocking;
}
