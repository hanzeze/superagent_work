# 小屿 Work — 个人生活助手

一个独立运行在 DeepSeek Harness (DSH) 持久 Session 上的个人 Work 空间。集中管理当前工作、日程、结构化进展、历史与小屿对话。项目通过 Host Service、Remote API、Agent Tools 和浏览器 Client Plugin 扩展 DSH，不修改 DSH 内核，也不依赖现有工程。

## 开发与验证

需要 Node.js 22.13+、可用的 DSH 0.2.1-rc.3。

```sh
npm ci
npm run check
```

`npm run check` 进行严格 TypeScript 检查、领域持久化测试，以及 Host/浏览器 bundle 构建。运行时不加载 TypeScript 源码；修改后必须重新构建。

## 独立安装和启动

以下只创建名为 `personal` 的新 DSH profile，不修改已有 `web` 或桌面 profile：

```sh
dsh --profile personal --from-default-profile web --dump-config >/dev/null  # 仅首次
npm run build
dsh plugin --profile personal add "file:$PWD/packages/life-assistant"  # 仅首次
# 后续版本先 npm run build，再：
dsh plugin --profile personal update @local/life-assistant
npm start
```

在终端显示的确切 `http://127.0.0.1:8877/?token=...` 地址打开新 profile；它不会更新已有的 `http://127.0.0.1:8805` GUI。侧栏 **Work** 是主入口。不要将 token 写进仓库或公开截图。首次运行的 DSH 模型仍使用用户自己的本地凭据，仓库不包含凭据。

## 数据与行为

- 事实存于 `$HOME/.dsh/life-assistant/life.db`（SQLite WAL）。可以分别通过 `LIFE_ASSISTANT_DB` 和 `LIFE_ASSISTANT_CWD` 覆盖数据库与 Agent 工作目录；启动前设置，并重新安装/启动 profile。
- 任务、日程、对话、命令、事件、审计、外部投递和 Outbox 均持久化。业务修改、事件、审计和幂等回执在一个事务中提交；App 与 Agent 使用同一个命令入口。
- 更新必须携带当前实体 `revision`，冲突明确拒绝，不会覆盖另一入口的新修改。`commandId` 重放需与原请求完全一致。
- 用户消息先保存为 `accepted`，后台创建/续用 DSH Session，再执行；界面轮询与订阅只读取投影，不占用消息写入入口。回答完成与界面可见分开记录。
- 取消是独立控制：尽量取消当前 Session turn，不回滚已经完成的任务/日程，也不宣称任意时刻严格打断；DSH 的 steer 仍只在步骤边界生效。
- 日程事实立即保存，异步同步 DSH Schedule。外部创建/删除有失败重试、恢复与记录；不是飞书同步或离线推送。更新通过可观察的替换实现；若跨创建/删除进程崩溃，数据库中保留待处理 Outbox，恢复后会再次尝试，不保证外部补偿绝不产生重复。
- 当前仅单用户、单 owner。Remote 强制使用服务端 owner，Agent 工具固定来源与权限，不提供任意 owner 参数。生产多用户部署前必须增加身份认证与每 owner 存储隔离。
- 当前投递能力为 in-app，不包含飞书、短信、邮件或语音全双工。日程的 DSH 通知依赖运行中的 Host 和模型配置。

## 界面

- 概览：当前焦点、即将到期日程、今日事项与即时对话。
- 任务：状态筛选、检索、结构化里程碑、下一步、阻塞与完成/重开。
- 日程：ISO 时间、显式时区、任务关联、编辑和独立取消。
- 历史：持久 DomainEvent 与 Agent 对话。
- 小屿对话：可关闭/最小化；查询、创建任务、取消对话不会等待无关模型推理。关闭浏览器后，后台状态仍可恢复。

无数据是合法初始状态，不注入虚构工作。截图应使用明确的测试数据或用户真实授权的数据，不得包含 DSH token、个人 Feishu 内容或模型凭据。

## 代码

- `packages/life-assistant/src/contract.ts`：与渠道无关的共享契约。
- `src/server/store.ts`：SQLite 事务、CAS、命令去重、事件、审计和 Outbox。
- `src/server/service.ts`：Host Service、权限边界、Agent Tools、Session 和 Schedule 适配。
- `src/remote.ts`：客户端/服务端共享的 Typert Remote 元数据和 schema。
- `src/client/`：React Work 主面板与侧栏入口。
- `tests/store.test.ts`：可重复运行的隔离数据库测试。

这是首个独立版本；外部渠道适配器和多人身份隔离尚未实现。
