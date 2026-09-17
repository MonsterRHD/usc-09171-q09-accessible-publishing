import { nextId, recordEvent } from "./store.mjs";
import { DomainError } from "./domain.mjs";

// 观众纠错：只保留处理所需信息。联系方式与正文分离存放，
// 普通编辑看不到联系方式；处理完成后联系方式即被删除。
// 审计事件永远不写入联系方式。
const ALLOWED_FIELDS = new Set(["object_id", "channel", "description", "contact"]);
const ALLOWED_CONTACT_FIELDS = new Set(["name", "email", "phone"]);

export function createCorrection(state, actor, input = {}) {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new DomainError(400, "field_not_allowed", `字段 ${key} 不属于处理所需信息，不予接收`);
    }
  }
  const { object_id = null, channel = null, description, contact } = input;
  if (typeof description !== "string" || !description) {
    throw new DomainError(400, "invalid_description", "纠错需要问题描述");
  }
  if (object_id !== null && !state.objects.has(object_id)) {
    throw new DomainError(400, "unknown_object", `对象 ${object_id} 不存在`);
  }
  if (contact !== undefined) {
    if (contact === null || typeof contact !== "object" || Array.isArray(contact)) {
      throw new DomainError(400, "invalid_contact", "联系方式必须是对象");
    }
    for (const key of Object.keys(contact)) {
      if (!ALLOWED_CONTACT_FIELDS.has(key)) {
        throw new DomainError(400, "contact_field_not_allowed", `联系方式字段 ${key} 超出处理所需范围`);
      }
    }
  }
  const correction = {
    id: nextId(state, "cor"),
    object_id,
    channel,
    description,
    status: "open",
    has_contact: Boolean(contact),
    created_at: state.now(),
    resolved_at: null,
    resolution: null,
  };
  state.corrections.set(correction.id, correction);
  if (contact) {
    state.correctionContacts.set(correction.id, {
      name: contact.name ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
    });
  }
  recordEvent(state, "correction_created", {
    correction_id: correction.id,
    object_id,
    channel,
    has_contact: correction.has_contact,
  });
  return correction;
}

// 普通编辑视图：永不包含联系方式
export function correctionView(correction) {
  return {
    id: correction.id,
    object_id: correction.object_id,
    channel: correction.channel,
    description: correction.description,
    status: correction.status,
    has_contact: correction.has_contact,
    created_at: correction.created_at,
    resolved_at: correction.resolved_at,
    resolution: correction.resolution,
  };
}

export function getCorrectionContact(state, correctionId) {
  if (!state.corrections.has(correctionId)) {
    throw new DomainError(404, "correction_not_found", `纠错 ${correctionId} 不存在`);
  }
  const contact = state.correctionContacts.get(correctionId);
  if (!contact) {
    throw new DomainError(404, "contact_unavailable", "联系方式不存在或已按最小化原则删除");
  }
  return contact;
}

export function resolveCorrection(state, actor, correctionId, input = {}) {
  const correction = state.corrections.get(correctionId);
  if (!correction) throw new DomainError(404, "correction_not_found", `纠错 ${correctionId} 不存在`);
  if (correction.status === "resolved") throw new DomainError(409, "already_resolved", "该纠错已处理完成");
  correction.status = "resolved";
  correction.resolved_at = state.now();
  correction.resolution = typeof input.resolution === "string" ? input.resolution : null;
  // 处理完成后联系方式不再属于"处理所需信息"，立即删除
  state.correctionContacts.delete(correctionId);
  correction.has_contact = false;
  recordEvent(state, "correction_resolved", {
    correction_id: correction.id,
    resolved_by: actor.id,
  });
  return correction;
}
