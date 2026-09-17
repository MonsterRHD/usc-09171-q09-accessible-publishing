// 角色与内容组件的分域归属。
// 馆员负责事实与术语，无障碍顾问负责四类适配内容，版权人员负责图片授权。
export const ROLES = {
  CURATOR: "curator",
  ACCESSIBILITY: "accessibility",
  COPYRIGHT: "copyright",
  EDITOR: "editor",
  COORDINATOR: "coordinator",
};

// 一个完整内容包必须包含的五类语义组件。
export const COMPONENT_TYPES = [
  "terminology", // 术语：说明“这是什么”（原件 / 可触摸复制品）
  "alt-text", // 替代文本
  "tactile-cue", // 触觉提示
  "easy-read", // 易读说明
  "audio-script", // 语音脚本
];

// 每类组件唯一的确认责任域，确认动作只允许对应角色执行。
export const COMPONENT_RESPONSIBLE_ROLE = {
  terminology: ROLES.CURATOR,
  "alt-text": ROLES.ACCESSIBILITY,
  "tactile-cue": ROLES.ACCESSIBILITY,
  "easy-read": ROLES.ACCESSIBILITY,
  "audio-script": ROLES.ACCESSIBILITY,
};

// 各渠道从同一个内容包中取用的组件子集。
// 内容包对所有渠道保持同一份事实与版本，渠道只决定呈现哪几类组件。
export const CHANNEL_PROFILES = {
  "touch-label": ["terminology", "tactile-cue", "easy-read"],
  miniapp: ["terminology", "alt-text", "easy-read"],
  "audio-guide": ["audio-script"],
  "web-kiosk": ["terminology", "alt-text", "easy-read", "audio-script"],
};

// 渠道是否实际呈现图片。语音渠道与线下触摸标签不承载图片，
// 因此图片许可撤回不构成这些渠道的失效或重发理由。
export const CHANNEL_PRESENTS_IMAGES = {
  "touch-label": false,
  miniapp: true,
  "audio-guide": false,
  "web-kiosk": true,
};
