import { DomainError } from "./domain.mjs";
import { currentDisplay, displayPairs, displayTimeline } from "./timeline.mjs";

// 审计：还原任意时间点各渠道真正展示过的内容版本。
export function displayedAt(state, at) {
  const effectiveAt = at ?? state.now();
  if (Number.isNaN(Date.parse(effectiveAt))) {
    throw new DomainError(400, "invalid_time", "at 必须是合法的时间");
  }
  const displayed = [];
  for (const { channel, object_id } of displayPairs(state)) {
    const current = currentDisplay(state, channel, object_id, effectiveAt);
    if (current) displayed.push({ channel, object_id, ...current });
  }
  displayed.sort((a, b) => a.channel.localeCompare(b.channel) || a.object_id.localeCompare(b.object_id));
  return { at: effectiveAt, displayed };
}

export function channelTimeline(state, channel, objectId) {
  const pairs = objectId ? [{ channel, object_id: objectId }] : displayPairs(state).filter((p) => p.channel === channel);
  const objects = [];
  for (const pair of pairs) {
    const { intervals, open } = displayTimeline(state, pair.channel, pair.object_id);
    objects.push({
      object_id: pair.object_id,
      intervals: intervals.map((iv) => ({ ...iv })),
      current: open,
    });
  }
  return { channel, objects };
}
