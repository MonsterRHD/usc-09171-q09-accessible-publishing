# 文博无障碍内容发布

项目面向馆员、无障碍顾问和多渠道内容团队。当前只提供服务入口以及既有渠道回执样例，事实版本、分域确认和发布影响计算尚未建立。

`contracts/channel-receipts.json` 中的回执来自不同渠道，`package_digest` 表示渠道收到的完整内容包，`displayed_at` 为空时不能视为已经公开展示。相同回执可能重复投递。

执行 `npm start` 启动服务，健康检查是 `GET /health`，基础检查使用 `npm test`。
