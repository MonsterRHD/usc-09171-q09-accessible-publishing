# 文博无障碍内容发布

面向馆员、无障碍顾问、版权人员与内容编辑的多渠道无障碍语义发布服务。它解决的核心问题是：
**线下触摸标签、小程序、语音导览各自通过审核，却可能共同对外呈现互相矛盾的版本**
（例如标签写“可触摸复制品”、小程序写“青铜器”、语音沿用已撤回的年代判断）。

服务采用事件溯源（event sourcing）：每次事实、确认、授权、构建、投递、回执、撤下与办结都是
不可变事件；当前状态与任意历史时间点的渠道展示状态都由事件重放得到，审计链不依赖易失状态。

## 领域模型与规则

### 1. 对象身份先隔离，公开端才不会混用对象

- 原件（`original`）与可触摸复制品（`touch-replica`）必须登记为**不同对象**，身份不可改写。
- 内容包按对象内容寻址（`sha256` 摘要），投递时校验归属：**复制品的包不能以原件名义投递**。
- 一个渠道可以同时展示多个对象（同一面触摸标签墙既有原件也有复制品），渠道展示状态按对象键控。

### 2. 一份核心事实，五类语义组件，版本关系可计算

- 核心事实（年代、定名等）由**馆员**记录；事实带 `factsHash`，可撤回（如撤回年代判断）。
- 五类组件：术语 `terminology`、替代文本 `alt-text`、触觉提示 `tactile-cue`、
  易读说明 `easy-read`、语音脚本 `audio-script`。每个组件版本记录它**基于哪个事实版本**。
- 分域确认，各角色只能确认自己负责的部分：

  | 组件 | 唯一确认角色 |
  | --- | --- |
  | 术语 | 馆员 `curator` |
  | 替代文本 / 触觉提示 / 易读说明 / 语音脚本 | 无障碍顾问 `accessibility` |
  | 图片授权（授予 / 撤回） | 版权人员 `copyright` |

- 内容包构建是一道**门禁**：只挑选“基于当前事实版本 **且** 经责任域确认”的最高组件版本，
  并要求包内图片授权有效。任一项不满足都会返回结构化 `blocking` 清单，不产生可投递的包。
- 事实撤回后，基于旧事实的组件版本**不能靠一次新确认复活**，必须按新事实重新起草、重新确认；
  旧审核不构成继续发布的理由。
- 组件正文未变的重新确认不会产生新内容（正文哈希参与摘要，元数据不参与）。

### 3. 渠道投递与回执：收到 ≠ 展示，回执可重复

- 渠道画像决定一个包中哪些组件在该渠道呈现；所有渠道收到的是同一份事实与版本。
- 回执状态沿用 `contracts/channel-receipts.json`：
  - `accepted`：渠道**收到内容包**，不等于公开展示（`displayed_at` 为空）；
  - `displayed`：渠道确认**已经展示**（必须带 `displayed_at`）；
  - `failed`：投递失败，可重试，系统记录尝试次数与全部回执。
- 同一回执（相同 `receipt_id`）重复投递是**幂等**的，只记录到达，不改变状态。
- 迟到回执防护：撤下之后到达的旧“已展示”回执、或已被新投递取代的旧包迟到回执，
  都不会让渠道回滚或悄悄恢复旧版本（时间线记录为 `stale-display-after-pull` /
  `stale-superseded-display`）。
- 时间一律按绝对时刻比较，回执与事件使用任意时区写法都不会误判先后。

### 4. 精确失效与待重发范围

核心事实或许可变化后，`GET /objects/:id/resend-scope` 逐渠道给出真实状态：

- `displayed-current`：展示中且仍有效，无需动作；
- `displayed-stale`：旧版本仍在展，**必须重发**，并给出原因（事实变更 / 图片许可撤回）；
- `resend-in-flight`：旧版本在展，但替代包已投递、尚未展示——等待即可，不要求重复重发；
- `in-flight`：当前有效包已投递，等待回执 / 等待展示（accepted≠displayed）；
- `dispatch-invalidated`：**在途包**在展示前事实或许可已变化，即使渠道随后展示也必须替换；
- `delivery-failed`：需要重试；`pulled`：紧急撤下尚未补发；`superseded`：投递已被取代。

图片许可撤回只影响**实际呈现图片且授权范围覆盖**的渠道；语音导览等不承载图片的渠道
不因图片问题失效，避免给出错误的重发范围。

### 5. 紧急纠错：先撤下，之后必须补齐

- `POST /objects/:id/emergency-pull` 可先撤下指定渠道的有害表述，立即生效。
- 办结（`resolve`）必须同时补齐三要素，缺一拒绝：**原因**、**替代版本投递**、**批准人**；
  替代投递必须属于同一对象且覆盖被撤下的渠道。

### 6. 观众纠错隐私

- 观众入口 `POST /corrections` 无需内部身份，只保留处理所需信息；未留联系方式则不存任何身份信息。
- 联系方式与处理单**分开存放**：普通编辑的纠错列表看不到姓名/联系方式，也无权读取；
  仅协调员（`coordinator`）可按需读取。

### 7. 审计：还原任意时间点真正展示过的版本

- `GET /channels/:channel/display-at?at=<ISO 时间>`：重放事件到该时刻，返回渠道当时**真正在展**
  的对象、内容包摘要、事实版本与组件版本——“收到”不会被算作“展示”。
- `GET /channels/:channel/timeline`：渠道完整状态时间线（展示、撤下、重复回执、迟到旧回执）。
- `GET /objects/:id/audit`：单个对象的完整事件轨迹。

## HTTP 接口

内部接口通过请求头 `x-actor-id` / `x-actor-role` 标识角色；渠道回执与观众纠错入口无需内部身份。

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /objects` | 馆员/协调员 | 登记原件或可触摸复制品 |
| `POST /objects/:id/facts` | 馆员 | 记录新核心事实版本 |
| `POST /objects/:id/facts/:version/retract` | 馆员 | 撤回事实版本 |
| `POST /objects/:id/components` | 编辑等 | 起草五类组件之一 |
| `POST /objects/:id/components/:type/:version/confirm` | 馆员/无障碍顾问 | 分域确认 |
| `POST /objects/:id/images/grant` | 版权 | 授予图片许可（可限渠道范围） |
| `POST /objects/:id/images/:imageId/withdraw` | 版权 | 撤回图片许可 |
| `POST /objects/:id/packages` | 编辑/协调员 | 门禁校验并构建内容包，返回 `digest` 或 `blocking` |
| `POST /objects/:id/dispatches` | 编辑/协调员 | 向指定渠道投递内容包 |
| `POST /dispatches/:id/retry` | 编辑/协调员 | 失败重试 |
| `POST /receipts` | 渠道（无身份） | 回执 webhook，兼容下划线字段，幂等 |
| `POST /objects/:id/emergency-pull` | 编辑/协调员 | 紧急撤下 |
| `POST /corrections` | 观众（无身份） | 提交纠错，联系方式可选 |
| `GET /corrections` | 编辑/协调员 | 纠错列表（不含联系方式） |
| `GET /corrections/:id/contact` | 仅协调员 | 按需读取联系方式 |
| `POST /corrections/:id/resolve` | 协调员 | 补齐原因/替代版本/批准人后办结 |
| `GET /objects/:id/resend-scope` | 编辑/协调员/馆员 | 逐渠道失效与待重发范围 |
| `GET /objects/:id/dispatches` | 编辑/协调员/馆员 | 投递实况（摘要、尝试次数、回执、部分上线） |
| `GET /objects/:id/audit` | 协调员/馆员 | 对象事件轨迹 |
| `GET /channels/:channel/timeline` | 内部角色 | 渠道时间线 |
| `GET /channels/:channel/display-at?at=` | 内部角色 | 还原历史时刻真实展示版本 |

## 运行与测试

```bash
npm start                 # 启动服务，健康检查 GET /health，默认端口 8080
PORT=8080 npm start
EVENT_LOG_PATH=data/events.jsonl npm start   # 事件持久化到 JSONL，重启后完整重放审计历史
npm test                  # 运行全部单元与 HTTP 集成测试
```

`contracts/channel-receipts.json` 是既有渠道回执样例，集成测试直接用它验证
`accepted`/`displayed` 区分与重复投递幂等。
