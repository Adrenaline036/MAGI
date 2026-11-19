# 架构说明

## 组成与数据流

```text
Codex → MCP 服务 → 本机 HTTP 桥 → 指定 DSH 会话
Codex ← 桌面发送入口 ← 回复回推脚本 ← DSH 回复正文

Codex → 外审协调器 → 只读审查者 → 结构化裁决
```

DSH 宿主插件运行在应用的可信组合内部，通过会话 API 投递消息。Codex 侧 MCP 读取本机发现文件，使用其中的令牌调用回环 HTTP 接口。讨论和正式外审使用不同执行路径。

## 讨论投递

`lib/index.js` 负责 HTTP 接口、定位、接纳和审计。入站消息使用 `plugin:magi` 来源，包含独立生成的消息 ID 和角色信息；原文放在前面，来源与投递信息放在尾部。

DSH 的 `steer` 进入 `next-step`，供当前回合在下一步边界读取，空闲时会唤醒驱动；`followup` 进入 `next-turn`，等当前回合结束；`inject` 进入待处理上下文但不唤醒。关闭的目标会话会被拒绝，桥不会代替用户打开它。

定位首先尊重显式选择。标题取自持久化 `session/title` 事件；活动时间取会话目录内最新文件的时间。多个会话共用项目目录时，项目路径不能唯一标识收件会话。

## Codex 回程

`lib/mcp-server.mjs` 从本次工具调用的元数据获取来源线程，并登记当前桌面端点。端点收据按线程分别保存，记录不可变；桌面重启产生新收据。`CODEX_APP_TOOLS_PIPE_PATH` 必须通过 MCP 的 `env_vars` 传递。

`lib/codex-desktop-delivery.mjs` 使用标准 stdio MCP 协议调用已安装的 `codex-app-tools`。初始化后只发送一次 `send_message_to_thread`，目标 UUID 同时用于调用参数和线程元数据。重复初始化响应不会造成重复发送。

统一回复入口要求明确线程，且不暴露模式或传输参数；旧脚本只转交该入口。初始化失败、断连、超时或响应格式异常均不会自动重试；请求已提交但未获确认时，错误明确提示结果未知，要求先检查目标。

## 外审与执行限制

`lib/review-bridge.mjs` 校验审查包，选择 DSH 启动方式和模型路由，生成协调工作流，再验证返回的裁决。审查者读取候选，协调器提供声明测试的原始执行输出。

裁决身份由 `(package_id, nonce, candidate hash)` 组成。桥在审查前后计算候选指纹；生成的工作流将身份绑定在脚本中，避免由模型重新抄写。

`lib/review-execution-guard.mjs` 限定工具、脚本和命令。协调器只允许规定的工作流调用；审查者的 shell 只能执行声明测试。工作流 `args` 可以是空对象或表示空对象的 JSON 文本。合法正数 `timeoutMs` 不因大于声明测试预算而拒绝，但无效数字、非正数及声明外命令仍被拒绝。

工作流脚本只容忍首尾空白与字节顺序标记差异，正文必须一致。身份不匹配、测试状态未知或裁决不可读都会被明确记录。`PASS` 仅覆盖当前候选和声明条款，不替代实机验收。

## 本机数据

| 数据 | 路径或用途 |
|---|---|
| 宿主发现文件 | `$DSH_HOME/magi.json`，包含端口、进程和访问令牌。 |
| 接纳审计 | `$DSH_HOME/magi.log.jsonl`。 |
| 项目路由 | `$DSH_HOME/magi-routing.json`，可通过 `MAGI_ROUTING` 指定。 |
| 桌面端点 | `$CODEX_HOME/magi-desktop-targets/<线程 UUID>/`。 |
| 审查证据 | `$DSH_HOME/reviews/<审查包 ID>/`。 |

这些数据不属于发布内容。发现文件只反映当前运行实例，不能长期缓存端口、进程号或令牌。

会话日志可能采用 `session.jsonl.zstd` 或 `session.v<N>.jsonl.zstd`，并包含多个压缩帧。所有读取统一通过 `lib/session-log.mjs`，避免只读到第一帧或选错格式代际。

## 文件职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主 HTTP 服务、接纳与审计。 |
| `lib/mcp-server.mjs` | 三个 MCP 工具及来源线程登记。 |
| `lib/codex-desktop-delivery.mjs` | 桌面端点登记与默认回推。 |
| `lib/review-bridge.mjs` | 外审协调、候选指纹与裁决验证。 |
| `lib/review-execution-guard.mjs` | 外审执行范围限制。 |
| `lib/routing.js` | 项目、节点、标题与会话定位。 |
| `lib/session-log.mjs` | 会话日志与执行证据读取。 |
| `lib/home.mjs` | DSH 数据目录解析。 |
| `lib/budgets.mjs` | 外审和测试预算常量。 |
| `lib/cli.mjs` | 手工诊断与路由管理。 |
| `lib/reply.mjs` | 唯一回复入口、来源标记、桌面投递及独立回执。 |
