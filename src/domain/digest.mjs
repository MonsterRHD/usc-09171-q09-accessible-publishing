import crypto from "node:crypto";

// 规范化 JSON：键排序后输出，保证相同语义内容永远得到相同摘要。
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// 组件正文摘要：只对事实载荷取摘要，元数据（版本号、批准人）不参与，
// 这样“正文未变、重新确认”不会产生新的待发布内容。
export function contentHash(body) {
  return `sha256:${sha256Hex(canonicalize(body))}`;
}

// 内容包摘要：对“各渠道将收到的完整载荷”取摘要，与渠道回执中的 package_digest 对齐。
// 载荷 = 资料对象身份 + 各组件的已确认版本及其内容哈希 + 图片授权状态。
export function packageDigest(bundle) {
  return `sha256:${sha256Hex(canonicalize(bundle))}`;
}
