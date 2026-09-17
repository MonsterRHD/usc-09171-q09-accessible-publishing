// 展示时间线：根据审计事件还原各渠道在各对象上"真正展示过"的内容版本。
// 展示起点采用渠道回执自报的 displayed_at（而非服务端收到回执的时间），
// 撤下采用服务端时间；同一 (渠道, 对象) 上后一次展示取代前一次。
export function displayTimeline(state, channel, objectId) {
  const relevant = state.events
    .filter(
      (e) =>
        (e.type === "delivery_displayed" || e.type === "delivery_taken_down") &&
        e.data.channel === channel &&
        e.data.object_id === objectId,
    )
    .map((e) => ({ at: e.data.effective_at ?? e.at, seq: e.seq, type: e.type, data: e.data }))
    .sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));

  const intervals = [];
  const takenDown = new Set(); // 撤下是终态：被撤下的投递不再因展示事件重新上线
  let open = null;
  for (const e of relevant) {
    if (e.type === "delivery_displayed") {
      if (takenDown.has(e.data.delivery_id)) continue;
      if (open) intervals.push({ ...open, until: e.at });
      open = {
        delivery_id: e.data.delivery_id,
        publication_id: e.data.publication_id,
        digest: e.data.digest,
        since: e.at,
      };
    } else {
      takenDown.add(e.data.delivery_id);
      if (open && open.delivery_id === e.data.delivery_id) {
        intervals.push({ ...open, until: e.at });
        open = null;
      }
    }
  }
  return { intervals, open };
}

// at 缺省时返回"当前仍在展示"的版本；给定 at 时返回该时刻正在展示的版本（或 null）
export function currentDisplay(state, channel, objectId, at) {
  const { intervals, open } = displayTimeline(state, channel, objectId);
  if (at === undefined || at === null) return open;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  for (const iv of intervals) {
    if (Date.parse(iv.since) <= t && t < Date.parse(iv.until)) return iv;
  }
  if (open && Date.parse(open.since) <= t) return open;
  return null;
}

// 出现过展示活动的全部 (渠道, 对象) 组合
export function displayPairs(state) {
  const pairs = new Set();
  for (const e of state.events) {
    if (e.type === "delivery_displayed" || e.type === "delivery_taken_down") {
      pairs.add(JSON.stringify([e.data.channel, e.data.object_id]));
    }
  }
  return [...pairs].map((key) => {
    const [channel, object_id] = JSON.parse(key);
    return { channel, object_id };
  });
}
