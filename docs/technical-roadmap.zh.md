# 个人生活助手 App：DSH 技术路线

## 1. 目标与结论

目标是做一个能看到当前 Work、日程、计划和历史，能直接编辑日程与计划，也能持续和 Agent 对话的个人生活助手 App。飞书继续可用，但不是唯一入口。

核心结论：

1. **Agent 运行在 DSH 持久 Session 上**，以自定义 profile、Host 服务插件、Remote API 和 Web 客户端插件实现，不 fork DSH 内核。
2. **App 与飞书共用同一事实和命令内核**，不是两套任务系统再互相同步。
3. **App 优先做成 DSH Web 的 React + TypeScript 插件**，通过响应式页面与 PWA 提供移动端体验；需要原生后台能力时再增加独立客户端，仍调用同一 Remote API。
4. DSH 提供可靠的 Agent 会话与插件底座，但**生活领域模型、App 业务投影、跨入口路由和完整日历仍需新开发**。
5. DSH 已有消息级双向能力，但 `steer` 不等于任意时刻打断模型生成。首版目标是**消息级双向并发与可取消**，不包含语音实时打断。

长期设计原则见仓库根目录 [AGENTS.md](../AGENTS.md)。开发、子任务和评审均应先阅读。

## 2. Super Agent 值得保留的核心思想

| 思想 | 在本项目中的落地 |
| --- | --- |
| 入口与执行分离 | App、飞书、定时器都是 Source；路由理解决策，执行者完成任务 |
| 先持久化再执行 | 消息、命令、授权、任务和外部副作用都有持久事实、稳定 ID 和去重键 |
| 事件与投影 | 领域事件产生 Work、进展和历史；App 读取适合展示的投影，不拼原始日志 |
| 持久任务与子会话 | 长任务可恢复、可追踪；子 Agent 有明确父级、所有权、权限和结束状态 |
| 事件订阅而非同步等待 | 任务通过事件协作，主路由可以处理新消息，查询不必唤醒执行者 |
| 独立控制面 | 查询、补充、修改、暂停、恢复和取消不共用一种模糊的消息语义 |
| Outbox 与幂等 | 业务变更与待投递事件原子提交，重试不重复创建日程、提醒或答复 |
| 最小权限与确认 | 权限由模型外的网关强制；敏感写先预览、后确认、留审计 |
| 完成与送达分离 | 工作完成、结果生成、渠道投递、用户收到分别记录 |
| 不绑定外壳 | 内核不认识 PR、飞书或某个页面，渠道和 UI 通过 Adapter 接入 |

不照搬的部分：Ticket/PR 编程交付语义、GitHub 工作流、只面向飞书的回复策略、把 Schedule 当日历的用法，以及现有界面布局。

## 3. Agent 具体如何运行

### 3.1 常驻主 Agent

使用 DSH `dsh-agent-loop`：

- 用稳定 `sessionId` 保存主会话，恢复已有个人上下文；不要依赖每次启动自动生成的新 Session。
- 使用标准“模型请求 → 工具调用 → 持久事件 → 下一步”循环，复用流式输出、持久历史、工具隔离和协作式取消。
- 主 Agent 负责识别新任务、补充、查询、修改和控制意图。简单查询走业务服务，长任务才派发。
- 个人偏好、时区、授权和项目原则使用 DSH 指令、Skill 或专用 Host 服务加载，不把所有事实永久堆进 system prompt。

### 3.2 子 Agent 与任务

复用 DSH `subagent` 的本地持久子会话、父子关系、继续输入、发现、容量限制和取消机制，但增加生活任务登记层：

```text
Task {
  id, ownerId, conversationId, sessionId,
  parentTaskId?, kind, state, priority,
  nextAction?, blockedReason?, revision,
  createdAt, updatedAt
}
```

- 子 Agent 创建前先登记 Task、授权范围和父级关系。
- 工具返回结构化结果，结果映射为 Task 状态与里程碑，不让模型只写一段“进展”。
- 首版不必为每种生活能力堆一个人格；一个通用执行 Agent 加少量能力插件即可。
- Task 是生活领域对象，DSH Session 是 Agent 执行历史，两者通过 ID 关联，不互相替代。

### 3.3 事实存储

- DSH Session 日志负责模型和工具执行历史。
- 新业务库负责 Task、Plan、CalendarEvent、ReminderLink、ConversationBinding、Command、DomainEvent、Outbox 和审计。
- 个人单机版从 SQLite 起步；多人部署、高并发或独立扩展 API 时再使用 PostgreSQL。通过数据访问接口隔离差异。
- 业务库内部使用事务和唯一约束。业务库与 DSH 日志不假装拥有跨存储原子事务，而以稳定关联 ID、状态机和恢复对账保证一致。

## 4. 如何建立在 DSH 插件系统上

以下 `@personal/*` 是建议的新包名，不是现有 DSH 包：

| 新插件 | 职责 | 复用的 DSH 能力 |
| --- | --- | --- |
| `@personal/profile` | 组合个人助手 profile、默认模型、权限与插件 | Cordis profile、patch、插件加载 |
| `@personal/app-source` | App 消息、命令、去重、会话绑定 | 持久 Session、prompt、inbox |
| `@personal/feishu-source` | 飞书事件接入和回复 Channel | 同一 Conversation / Router，独立投递适配器 |
| `@personal/work-service` | Task、命令、状态机、里程碑与权限 | Agent、subagent、事件与 Session projection |
| `@personal/calendar-service` | 日程、计划、重复规则、编辑、外部同步 | Schedule 仅用于提醒触发，不代替日历 |
| `@personal/app-api` | 类型化查询、命令、快照与增量流 | Typert Remote、API Gateway、访问控制 |
| `@personal/app-ui` | Work、日历、进展、历史页面 | DSH Web 客户端模块、会话与布局插件 |
| `@personal/conversation-ui` | App 内对话及与 Work 的互相跳转 | Session Controller、Conversation、流式事件 |
| `@personal/scheduler-link` | 领域事项与提醒触发、回执的关联 | DSH Schedule 的持久规则与投递记录 |
| `@personal/memory` | 用户偏好、记忆查看/删除、审计 | DSH 指令与 Skill 加载机制 |

关键边界：

- 业务状态放 Host 服务；React UI 不直接读写数据库或 Session 日志。
- 浏览器只经类型化 Remote API 访问；资源授权在 Host 对每个请求执行。
- DSH 客户端插件可以复用同一 Host 和 WebSocket，不需要另起一套 Agent 后端。
- 现有 Session、Schedule 和 Conversation UI 可复用；完整日历与 Work 页面是新产品代码。

## 5. 每一块的技术路线

### 5.1 App 与总体布局

- React + TypeScript，优先 DSH Web 客户端插件；页面分为今日/Work、日历与计划、进展、历史、对话。
- TanStack Query 管理服务端读取与失效；轻量本地 store 管理草稿、选中项和弹窗。
- 首次加载采用查询快照，后续用 Remote stream / WebSocket 接收增量；断线后以游标或新快照修复。
- 编辑采用显式草稿与保存结果，不用“请求已发出”冒充成功。
- 首版响应式 Web/PWA；推送、离线、后台执行是后续独立能力，不默认宣称 PWA 能可靠执行后台提醒。

### 5.2 当前 Work

Work 是查询投影，不是复制一份任务：

```text
WorkItem {
  taskId, title, state, priority,
  currentMilestone?, nextAction?, blockedReason?,
  planRefs, scheduleRefs, conversationRef,
  revision, updatedAt
}
```

- Work Service 消费任务、子 Agent、工具结果、用户编辑等事件，更新列表投影。
- 首页回答“正在做什么、下一步是什么、为什么停住”；详细工具日志折叠。
- 支持按任务打开关联对话、计划或日程，状态变化通过增量事件更新。
- 冷任务可以直接读库恢复视图，不需要先激活全部 Agent。

### 5.3 日程与计划

三类对象分开：

- **Plan**：目标、行动步骤、优先级、预期结果、关联 Work。
- **CalendarEvent**：标题、开始/结束时间、时区、重复规则、地点、来源。
- **Reminder**：何时向哪个会话或 Channel 投递什么内容，可引用 Plan/Event。

时间处理：

- 使用 Temporal 处理本地钟表时间、IANA 时区、UTC 时间点与重复展开。
- 原始 IANA 时区与规则保留；不能用固定 UTC 偏移替代时区。
- 日历事件支持时间区间；DSH Schedule 只保留其到点投递能力，并通过 `ReminderLink` 关联领域对象。

编辑统一走命令：

```text
CreatePlan / UpdatePlan / DeletePlan
CreateEvent / MoveEvent / CancelEvent
LinkReminder / PauseReminder / ResumeReminder
```

- 所有对象有 `revision`，更新用乐观锁/CAS 防止手改与 Agent 修改相互覆盖。
- `commandId` 有唯一约束，安全重试返回同一结果。
- 每次变更保存旧值/新值、操作者、来源、授权和关联对象，支持审计。
- 飞书日历等外部系统通过 Adapter 同步；记录外部 ID、同步游标、冲突和重试状态，不能假设外部写入必定成功。

### 5.4 进展

建议状态机：

```text
pending → running → waiting_confirmation → completed
                 ├→ blocked
                 ├→ failed
                 └→ cancelled
```

- 进展由里程碑、当前步骤、下一步、阻塞原因、更新时间和结果引用组成。
- 长任务只在状态或里程碑改变时推送；高频日志留在详情。
- 取消是命令，返回实际结果；中断模型不代表外部副作用已回滚。
- 内部完成、外部动作执行、通知投递分别记录，App 不把“已发送”显示成“已完成任务”。

### 5.5 历史与搜索

- 工作历史：任务状态、里程碑、结果、异常和关联 Session。
- 日程/计划历史：谁在何时从哪个入口做了什么改动。
- 对话历史：可复用 DSH Session Query、分页、投影和 SQLite FTS 搜索能力。
- 业务历史使用自己的 DomainEvent 与投影，不从模型文本反推。
- 历史按游标分页，列表不加载完整日志；冷 Session 无需激活。
- DSH Session Query 是可信底层查询服务，不自动等于用户授权；App API 必须校验 owner、资源角色和父子可见范围。

### 5.6 直接编辑与一致性

手动操作与 Agent 工具最终调用同一领域服务：

```text
App / Agent
    ↓ Command + owner + commandId + expectedRevision
权限网关 → 参数校验 → 业务事务
    ├─ 更新领域对象
    ├─ 追加 DomainEvent / 审计
    └─ 写入 Outbox
        ↓
    Work / 历史 / App 实时投影 + 外部 Adapter
```

- UI 传 `expectedRevision`，冲突返回当前对象，要求合并或重新确认。
- 只有事务提交后才显示“已保存”；无法确认时先查询，不盲目重试写操作。
- 删除优先采用可审计的取消/归档语义；真正物理删除走单独权限和保留策略。

### 5.7 App 中与 Agent 对话

- App Source 接收消息后先持久化，并创建/解析 `ConversationBinding`：它关联 owner、主 Session、入口、当前 Task 和可选 Plan/Event。
- 一般提问发给常驻主 Agent；状态查询直接读取 Work Service，避免等待模型。
- 长任务通过受控子 Agent 执行，主会话仍能接受新问题或控制命令。
- 回复使用 DSH Session Controller 的持久历史与流式事件；数据库/Session 中已接受的事实优先于页面临时状态。
- 对话中引用 Task、Plan 或 Event 时传结构化 ID，前端渲染可点击卡片，不靠标题猜测对象。
- 飞书和 App 都可关联到同一业务对话，但原始消息权限与可见范围不因关联而自动共享。

### 5.8 提醒、通知与外部日历

- DSH Schedule 负责持久提醒规则、到点投递与已有回执；App 通知是新的 Delivery Channel。
- 领域服务决定提醒关联的 Event/Plan，以及触发后应创建任务、发送通知还是唤醒 Agent。
- App 在线时走实时连接；离线推送使用独立 Push Adapter 和设备注册，失败重试有幂等键。
- 删除日程不自动等于已取消全部外部动作，必须按关联关系执行并记录补偿结果。
- 外部日历采用同步游标、幂等外部写入和明确冲突策略，不能定时全量覆盖。

### 5.9 权限、隐私与记忆

- 所有业务对象带 `ownerId`；Remote API 以调用方身份和资源关系授权，不能信任客户端提交的 owner。
- DSH Remote Access 可作为 Session 等资源授权底座；新业务资源需注册对应资源与策略。
- 工具按 read、reversible_write、sensitive_write 分级，子 Agent 只获得当前任务需要的最小工具集。
- 密钥只在宿主凭证层，不进入 prompt、日志、子 Agent 环境或浏览器。
- 区分明确个人资料、稳定偏好、临时上下文和完整历史；支持查看、更正和“忘掉”。
- 项目原则通过版本化指令与 Skill 长期加载；偏好与私人事实则存受权限控制的数据服务，二者不混用。

## 6. DSH 是否支持全双工

需要区分传输、Agent 和产品三个层面：

| 层面 | DSH 当前能力 | 本项目要补的内容 |
| --- | --- | --- |
| 流式下行 | 模型 token、Session 事件和 Remote stream 可持续推送 | App 业务投影、断线恢复和消息节流 |
| 客户端上行 | prompt 可 queue/steer，Remote stream 也支持 Client 回送 | 统一意图、目标对象、幂等和权限 |
| 运行中补充 | steer 在最近 step 边界被领取 | 明确“已收到但尚未采纳”的界面状态 |
| 中断 | Agent 支持协作式 cancel，工具可响应 AbortSignal | 取消回执、外部副作用补偿、子任务传播 |
| 多任务并发 | 持久子 Agent、独立 Session、后台 activation | 主路由不阻塞、生活 Task 登记、跨入口关联 |

因此，准确说法是：

> **DSH 足以作为消息级双向 App 的底座，但不能把 steer 宣称成严格的全双工。**它不会让正在生成的模型瞬间读取新文字；单 Agent 的轮次也仍有顺序。取消也不能保证撤销已发生的外部写入。

产品首版采用“常驻主路由 + 受控子任务 + 独立控制命令 + 结构化查询”实现用户可感知的双向并发。语音全双工另立项目。

## 7. 推荐实施阶段

### 阶段 A：DSH 骨架与只读 App

- 建自定义 profile、主 Agent、业务库、Task/Plan/Event 模型与 Remote API。
- 建 Work、日程、进展、历史的只读页面和实时投影。
- 验证重启后 Session、任务和 App 游标恢复；未激活 Agent 也能读历史。

### 阶段 B：编辑与提醒闭环

- 实现统一命令、revision/CAS、幂等、Outbox、审计。
- 接入 Schedule 的 ReminderLink；完成 App 手动编辑与 Agent 编辑的同一状态验证。
- 验证时区、重复日程、冲突、重试、部分失败和取消后的补偿。

### 阶段 C：App 对话与任务控制

- App Source、ConversationBinding、主路由和受控子 Agent。
- 实现 queue/steer、查询、暂停/恢复/取消及真实回执。
- 验证长任务运行时仍能新对话，消息不串任务，重启不重复执行。

### 阶段 D：外部同步与发布能力

- 飞书日历、通知、离线推送和必要的原生客户端。
- 完整权限评审、数据导出/删除、故障恢复与端到端验收。

## 8. 首版验收的关键场景

1. App 新建计划并拆成日程后，飞书与 App 看到同一对象和状态。
2. Agent 与用户同时修改同一日程时，后写者收到冲突，不会静默覆盖。
3. “安排下周三次运动，避开已有日程”先读冲突并预览，确认后只创建一次。
4. “把第三次改到周日，其他不变”只修改目标对象，历史保留旧值。
5. 长任务执行中可以询问其他日程、发起新任务或取消指定任务。
6. steer 尚未被领取、已领取、取消已生效、外部动作待补偿，界面显示不同状态。
7. 重启、断线、重复事件和重试不会重复创建日程、提醒、任务或答复。
8. 用户能查看和删除个人记忆；无权用户不能通过 Session、历史或搜索接口读取他人数据。

## 9. 最终架构判断

**选择 DSH，不是把 Super Agent 整体搬进来，而是让 DSH 承担持久 Agent、工具、子会话、提醒、Remote 和 Web 插件底座；Super Agent 的入口路由、持久任务、事件投影、可靠交付与权限思想则用于设计新的生活领域插件。**

这样既能复用现成基础设施，也能保持 App、飞书和未来客户端共享同一套事实，而不受代码助手或某个聊天渠道的约束。
