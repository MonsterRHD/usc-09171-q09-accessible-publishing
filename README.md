# 文博无障碍内容发布

面向馆员、无障碍顾问、版权人员与多渠道内容团队的无障碍语义发布服务。事实、术语、替代文本、触觉提示、易读说明与语音脚本按版本关联；核心事实或授权变化时，系统精确算出必须失效的渠道内容；审计可以还原任意时间点各渠道真正展示过的版本。

## 领域模型

- **对象（object）**：`original`（原件）与 `replica`（复制品）严格分离，复制品通过 `replica_of` 关联原件。事实与内容资产都绑定单一对象，跨对象引用会被拒绝（`cross_object_reference`），复制品描述不会传播到原件。
- **事实（fact）**：按对象版本化，跨渠道共用。新版本取代旧版本（`superseded`），撤回（`withdrawn`）只针对当前版本且不可逆。
- **授权（license）**：如图片许可，可撤回；图片资产必须绑定授权。
- **语义资产（asset）**：`terminology` / `alt_text` / `tactile_hint` / `easy_read` / `audio_script` / `image`，逐版本声明对事实版本与授权的依赖。
- **分域确认（confirmation）**：馆员确认 `curatorial` 域（术语、语音脚本），无障碍顾问确认 `accessibility` 域（替代文本、触觉提示、易读说明、语音脚本），版权人员确认 `rights` 域（图片）。任何人只能确认自己负责的域；确认绑定具体版本，不继承。
- **版本评估**：`cleared`（确认齐全且依赖有效，可发布）/ `unconfirmed`（缺确认）/ `stale`（依赖已被新版本取代，需重发）/ `invalid`（依赖被撤回或事实无有效版本，公开端立即停止展示）。旧审核不会成为继续发布的理由。
- **内容包（publication）**：组包时逐资产取最新 cleared 版本，摘要对内容做 sha256；同一内容包投到多个渠道时摘要一致，与既有回执样例约定兼容。
- **投递（delivery）**：`pending → awaiting_receipt → accepted → displayed`，另有 `failed`（记录错误与次数，可重试）、`superseded`（被新包作废）、`taken_down`（紧急撤下，终态）。发布响应与查询展示逐渠道实际状态，部分上线一目了然。
- **回执（receipt）**：`accepted`（收到内容包）与 `displayed`（已经展示）是两个状态，`displayed_at` 为空不视为已展示。同一回执允许重复投递，按 `receipt_id` 幂等去重；内容不一致的同号回执返回 409。
- **紧急撤下（takedown）**：先撤下（公开端立即不可见），之后必须补齐原因、替代版本与批准人，否则保持 `open` 并出现在待重发范围中。
- **观众纠错（correction）**：只接收处理所需字段（多余字段拒收）；联系方式单独存放，普通编辑不可见，处理完成后即删除；审计日志不记录联系方式。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/objects` `/facts` `/facts/:id/versions` `/facts/:id/withdraw` | 对象与事实（馆员） |
| POST | `/licenses` `/licenses/:id/withdraw` | 授权（版权人员） |
| POST | `/assets` `/assets/:id/versions` `/assets/:id/versions/:v/confirmations` | 资产与分域确认 |
| POST | `/publications` `/deliveries/:id/attempts` | 发布与投递重试（编辑） |
| POST | `/channels/:channel/receipts` | 渠道回执（幂等） |
| GET | `/public/channels/:channel/objects/:object` | 公开端当前应展示的内容 |
| GET | `/republish-scope` | 编辑的待重发范围（含失败重试、未补齐撤下） |
| POST | `/impact/compute` | 变更影响预演 |
| POST/PATCH | `/emergency-takedowns` | 紧急撤下与补齐 |
| POST | `/corrections` `/corrections/:id/resolve` | 观众纠错与处理 |
| GET | `/audit/displayed?at=` `/audit/channels/:channel/timeline` | 审计还原（审计员） |

身份通过请求头 `x-actor-id` / `x-actor-role` 传递（`curator` / `accessibility` / `copyright` / `editor` / `correction-handler` / `auditor` / `admin`）。

`contracts/channel-receipts.json` 中的回执来自不同渠道，`package_digest` 表示渠道收到的完整内容包，`displayed_at` 为空时不能视为已经公开展示，相同回执可能重复投递——发布流程完整兼容这项约定。

执行 `npm start` 启动服务，健康检查是 `GET /health`，基础检查使用 `npm test`。
