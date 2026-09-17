import { nextId, recordEvent } from "./store.mjs";
import { DomainError } from "./domain.mjs";
import { currentDisplay } from "./timeline.mjs";

// 紧急纠错：先撤下有害表述（公开端立即不可见），
// 之后必须补齐原因、替代版本与批准人，否则一直处于 open 状态并出现在待办中。
export function createTakedown(state, actor, input = {}) {
  const { channel, object_id, reason = null } = input;
  if (typeof channel !== "string" || !channel) throw new DomainError(400, "invalid_channel", "需要指定渠道");
  if (typeof object_id !== "string" || !object_id) throw new DomainError(400, "invalid_object", "需要指定对象");
  const current = currentDisplay(state, channel, object_id);
  if (!current) {
    throw new DomainError(409, "nothing_displayed", "该渠道当前没有正在展示的内容，无需紧急撤下");
  }
  const delivery = state.deliveries.get(current.delivery_id);
  if (delivery && delivery.status !== "taken_down") delivery.status = "taken_down";
  const takedown = {
    id: nextId(state, "td"),
    channel,
    object_id,
    delivery_id: current.delivery_id,
    publication_id: current.publication_id,
    digest: current.digest,
    status: "open",
    reason,
    replacement_publication_id: null,
    approver: null,
    created_at: state.now(),
    created_by: actor.id,
    backfilled_at: null,
    backfilled_by: null,
  };
  state.takedowns.set(takedown.id, takedown);
  recordEvent(state, "delivery_taken_down", {
    takedown_id: takedown.id,
    delivery_id: current.delivery_id,
    publication_id: current.publication_id,
    channel,
    object_id,
    digest: current.digest,
    effective_at: state.now(),
  });
  recordEvent(state, "takedown_created", {
    takedown_id: takedown.id,
    channel,
    object_id,
    digest: current.digest,
    created_by: actor.id,
  });
  return takedown;
}

export function backfillTakedown(state, actor, takedownId, input = {}) {
  const takedown = state.takedowns.get(takedownId);
  if (!takedown) throw new DomainError(404, "takedown_not_found", `紧急撤下 ${takedownId} 不存在`);
  if (takedown.status === "closed") throw new DomainError(409, "already_closed", "该紧急撤下已补齐并关闭");
  const { reason, replacement_publication_id, approver } = input;
  if (reason !== undefined) {
    if (typeof reason !== "string" || !reason) throw new DomainError(400, "invalid_reason", "原因不能为空");
    takedown.reason = reason;
  }
  if (replacement_publication_id !== undefined) {
    const publication = state.publications.get(replacement_publication_id);
    if (!publication) throw new DomainError(400, "unknown_publication", `替代版本 ${replacement_publication_id} 不存在`);
    if (publication.object_id !== takedown.object_id) {
      throw new DomainError(400, "replacement_object_mismatch", "替代版本必须属于同一对象，不得跨对象替换");
    }
    takedown.replacement_publication_id = replacement_publication_id;
  }
  if (approver !== undefined) {
    if (typeof approver !== "string" || !approver) throw new DomainError(400, "invalid_approver", "批准人不能为空");
    takedown.approver = approver;
  }
  if (takedown.reason && takedown.replacement_publication_id && takedown.approver) {
    takedown.status = "closed";
    takedown.backfilled_at = state.now();
    takedown.backfilled_by = actor.id;
    recordEvent(state, "takedown_backfilled", {
      takedown_id: takedown.id,
      channel: takedown.channel,
      object_id: takedown.object_id,
      reason: takedown.reason,
      replacement_publication_id: takedown.replacement_publication_id,
      approver: takedown.approver,
      backfilled_by: actor.id,
    });
  }
  return takedown;
}
