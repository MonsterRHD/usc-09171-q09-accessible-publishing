// 内存状态与审计事件日志。
// 所有状态变更都通过 recordEvent 追加事件，审计端可以据此还原任意时间点的公开展示版本。
export function createStore({ now = () => new Date().toISOString() } = {}) {
  return {
    now,
    seq: 0,
    idSeq: new Map(),
    objects: new Map(), // 展品对象：原件与复制品严格分离
    facts: new Map(), // 事实（按对象 + 键版本化）
    licenses: new Map(), // 授权（如图片许可）
    assets: new Map(), // 语义资产：术语/替代文本/触觉提示/易读说明/语音脚本/图片
    confirmations: [], // 分域确认记录
    publications: new Map(), // 内容包
    deliveries: new Map(), // 渠道投递（含重试与部分上线状态）
    receipts: new Map(), // 渠道回执（按 receipt_id 幂等去重）
    takedowns: new Map(), // 紧急撤下
    corrections: new Map(), // 观众纠错（不含联系方式）
    correctionContacts: new Map(), // 联系方式单独存放，处理完成即删除
    events: [], // 追加式审计日志，永不写入联系方式等敏感信息
  };
}

export function nextId(state, prefix) {
  const n = (state.idSeq.get(prefix) ?? 0) + 1;
  state.idSeq.set(prefix, n);
  return `${prefix}-${n}`;
}

export function recordEvent(state, type, data) {
  const event = { seq: (state.seq += 1), at: state.now(), type, data };
  state.events.push(event);
  return event;
}
