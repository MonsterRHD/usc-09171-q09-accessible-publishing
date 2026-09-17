// 投影模块只依赖事件结构；渠道画像等配置留在服务层使用。
// 纯函数投影：把事件流归约成当前读模型。
// 传入 {at} 可只归约到某个时间点，用于还原历史展示状态。
// 时间一律按绝对时刻比较，事件时间戳（UTC）与查询时间（任意时区写法）不得做字符串比较。
export function buildProjection(events, { at } = {}) {
  const state = createState();
  const cutoff = at ? Date.parse(at) : null;
  if (cutoff !== null && Number.isNaN(cutoff)) {
    throw new Error(`无法解析时间点 ${at}`);
  }
  for (const event of events) {
    if (cutoff !== null && Date.parse(event.at) > cutoff) break;
    reduce(state, event);
  }
  return state;
}

export function createState() {
  return {
    objects: {},
    packages: {}, // digest -> 已构建的内容包清单
    dispatches: {}, // dispatchId -> 投递记录
    channels: {}, // channel -> 渠道投递/展示状态
    receipts: {}, // receiptId -> 回执（幂等去重）
    corrections: {}, // correctionId -> 观众纠错（不含联系方式）
    contacts: {}, // correctionId -> 联系方式（受限读取，独立存放）
  };
}

function channelState(state, channel) {
  if (!state.channels[channel]) {
    state.channels[channel] = {
      channel,
      displayed: {}, // objectId -> {digest, displayedAt}：一个渠道可同时展示多个对象
      history: [], // 该渠道所有关键状态变化（审计时间线）
      pulls: [], // 按对象记录的紧急撤下
    };
  }
  return state.channels[channel];
}

function objectState(state, objectId) {
  if (!state.objects[objectId]) {
    state.objects[objectId] = {
      id: objectId,
      kind: null,
      label: null,
      currentFactVersion: null,
      factsHash: null,
      facts: {}, // version -> 事实修订
      images: {}, // imageId -> 授权状态
      components: {}, // type -> {current, revisions: {version -> ...}}
      corrections: [],
    };
  }
  return state.objects[objectId];
}

function reduce(state, event) {
  const { type, payload: p, at, actor } = event;
  switch (type) {
    case "ObjectRegistered": {
      const obj = objectState(state, p.objectId);
      obj.kind = p.kind;
      obj.label = p.label;
      break;
    }
    case "FactRecorded": {
      const obj = objectState(state, p.objectId);
      obj.facts[p.version] = {
        version: p.version,
        body: p.body,
        factsHash: p.factsHash,
        basis: p.basis ?? null,
        changeNote: p.changeNote ?? null,
        supersedes: p.supersedes ?? null,
        recordedAt: at,
        withdrawn: false,
      };
      obj.currentFactVersion = p.version;
      obj.factsHash = p.factsHash;
      break;
    }
    case "FactRetracted": {
      const obj = objectState(state, p.objectId);
      const fact = obj.facts[p.version];
      if (fact) fact.withdrawn = true;
      // 撤回的是当前事实：标记无有效事实，依赖它的组件全部失去事实基础。
      if (obj.currentFactVersion === p.version) {
        obj.currentFactVersion = null;
        obj.factsHash = null;
      }
      break;
    }
    case "ComponentDrafted": {
      const obj = objectState(state, p.objectId);
      if (!obj.components[p.componentType]) obj.components[p.componentType] = { revisions: {} };
      obj.components[p.componentType].revisions[p.version] = {
        version: p.version,
        body: p.body,
        contentHash: p.contentHash,
        basedOnFactVersion: p.basedOnFactVersion,
        basedOnFactsHash: p.basedOnFactsHash,
        confirmations: {},
        draftedAt: at,
        draftedBy: actor?.id ?? null,
      };
      break;
    }
    case "ComponentConfirmed": {
      const obj = objectState(state, p.objectId);
      const revision = obj.components[p.componentType]?.revisions[p.version];
      if (revision) {
        revision.confirmations[p.role] = { by: actor?.id, at };
      }
      break;
    }
    case "ImageLicenseGranted": {
      const obj = objectState(state, p.objectId);
      obj.images[p.imageId] = {
        imageId: p.imageId,
        status: "granted",
        scope: p.scope ?? { channels: null },
        grantedAt: at,
        withdrawnAt: null,
        withdrawalReason: null,
      };
      break;
    }
    case "ImageLicenseWithdrawn": {
      const obj = objectState(state, p.imageLicense?.objectId ?? p.objectId);
      const img = obj.images[p.imageId];
      if (img) {
        img.status = "withdrawn";
        img.withdrawnAt = at;
        img.withdrawalReason = p.reason;
      }
      break;
    }
    case "PackageBuilt": {
      state.packages[p.digest] = { ...p, builtAt: at };
      break;
    }
    case "ChannelDispatchCreated": {
      // 同一渠道、同一对象的在途旧投递（尚未真正展示）被新投递取代；
      // 此后到达的旧内容包回执不能再把渠道回滚到旧版本。
      for (const dispatch of Object.values(state.dispatches)) {
        if (
          dispatch.channel === p.channel &&
          dispatch.objectId === p.objectId &&
          ["awaiting-receipt", "accepted-awaiting-display", "failed"].includes(dispatch.state)
        ) {
          dispatch.state = "superseded";
        }
      }
      state.dispatches[p.dispatchId] = {
        ...p,
        createdAt: at,
        attempts: p.attempts ?? 1,
        lastAttemptAt: at,
        receipts: [],
        state: "awaiting-receipt", // awaiting-receipt | accepted-awaiting-display | displayed | failed | superseded
      };
      // 新投递意味着替代版本即将上线，此前的紧急撤下记录对后续展示不再构成阻塞。
      const ch = channelState(state, p.channel);
      for (const pull of ch.pulls) {
        if (pull.objectId === p.objectId && pull.clearedAt === null) pull.clearedAt = at;
      }
      break;
    }
    case "DeliveryRetried": {
      const dispatch = state.dispatches[p.dispatchId];
      if (dispatch) {
        dispatch.attempts = p.attempt;
        dispatch.lastAttemptAt = at;
        if (dispatch.state === "failed") dispatch.state = "awaiting-receipt";
      }
      break;
    }
    case "ChannelReceiptRecorded": {
      applyReceipt(state, event);
      break;
    }
    case "ContentPulled": {
      for (const channel of p.channels) {
        const ch = channelState(state, channel);
        const shown = ch.displayed[p.objectId];
        ch.pulls.push({
          correctionId: p.correctionId,
          objectId: p.objectId,
          digest: shown?.digest ?? p.digest ?? null,
          reason: p.reason,
          at,
          clearedAt: null,
        });
        delete ch.displayed[p.objectId];
        ch.history.push({
          kind: "pulled",
          objectId: p.objectId,
          at,
          correctionId: p.correctionId,
          reason: p.reason,
        });
      }
      break;
    }
    case "CorrectionFiled": {
      state.corrections[p.correctionId] = {
        correctionId: p.correctionId,
        objectId: p.objectId,
        channels: p.channels ?? [],
        description: p.description,
        status: p.pulled ? "pulled" : "filed",
        hasContact: false,
        filedAt: at,
        resolution: null,
      };
      break;
    }
    case "CorrectionContactStored": {
      const correction = state.corrections[p.correctionId];
      if (correction) correction.hasContact = true;
      // 联系方式独立存放，普通纠错查询不返回这一域。
      state.contacts[p.correctionId] = { name: p.name, contact: p.contact, storedAt: at };
      break;
    }
    case "CorrectionResolved": {
      const correction = state.corrections[p.correctionId];
      if (correction) {
        correction.status = "resolved";
        correction.resolution = {
          reason: p.reason,
          replacementDispatchId: p.replacementDispatchId,
          approver: { id: p.approverId, role: p.approverRole },
          at,
        };
      }
      break;
    }
    default:
      break;
  }
}

function applyReceipt(state, event) {
  const { payload: p, at } = event;
  const ch = channelState(state, p.channel);

  // 同一回执重复投递：只记录到达，幂等，不改变任何状态。
  if (state.receipts[p.receiptId]) {
    ch.history.push({ kind: "receipt-duplicate", receiptId: p.receiptId, at });
    return;
  }
  state.receipts[p.receiptId] = { ...p, recordedAt: at };

  // 渠道回执只携带渠道与内容包摘要，据此定位最近一次匹配的投递。
  const dispatch = Object.values(state.dispatches)
    .filter((d) => d.channel === p.channel && d.digest === p.digest)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const objectId = dispatch?.objectId ?? p.objectId ?? null;

  if (dispatch) {
    dispatch.receipts.push(p.receiptId);
    // 已被新投递取代或已展示的投递，迟到回执不能再改变其状态。
    if (!["superseded", "displayed"].includes(dispatch.state)) {
      if (p.status === "failed") {
        dispatch.state = "failed";
      } else if (p.status === "accepted") {
        dispatch.state = "accepted-awaiting-display";
      } else if (p.status === "displayed") {
        dispatch.state = "displayed";
      }
    }
  }

  // 撤下之后、且替代版本投递建立之前到达的旧“已展示”回执不能让内容悄悄恢复展示。
  const shownAt = Date.parse(p.displayedAt ?? at);
  const pulledOpen =
    objectId &&
    ch.pulls.some(
      (pull) =>
        pull.objectId === objectId && pull.clearedAt === null && Date.parse(pull.at) <= shownAt
    );
  // 已被新投递取代的旧包，其迟到回执同样不能把渠道回滚到旧版本。
  const superseded = dispatch?.state === "superseded";

  if (p.status === "displayed") {
    if (pulledOpen) {
      ch.history.push({
        kind: "stale-display-after-pull",
        objectId,
        digest: p.digest,
        receiptId: p.receiptId,
        at: p.displayedAt ?? at,
      });
    } else if (superseded) {
      ch.history.push({
        kind: "stale-superseded-display",
        objectId,
        digest: p.digest,
        receiptId: p.receiptId,
        at: p.displayedAt ?? at,
      });
    } else {
      ch.displayed[objectId] = { digest: p.digest, displayedAt: p.displayedAt ?? at };
      ch.history.push({ kind: "displayed", objectId, digest: p.digest, receiptId: p.receiptId, at: p.displayedAt ?? at });
    }
  } else {
    ch.history.push({ kind: p.status, objectId, digest: p.digest, receiptId: p.receiptId, at: p.receivedAt ?? at });
  }
}
