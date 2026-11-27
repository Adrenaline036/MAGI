# MAGI

让 Codex、DeepSeek Harness（DSH）与 Antigravity 按会话收发消息；代码外审由 DSH 执行。

MAGI 包含 DSH 宿主插件、Codex MCP 服务和回复回推脚本。讨论消息可以进入正在运行的回合；正式外审独立启动审查者，返回与候选内容绑定的结构化裁决。

## 功能

| 入口 | 用途 |
|---|---|
| `magi_message` | 定向发送、回复原发件会话，或向绑定的三端会话组广播。 |
| `magi_ask_dsh` | 把问题原文交给指定 DSH 会话，异步接收带 `[DSH]` 来源标记的回复。 |
| `magi_dsh_sessions` | 查看项目内的会话标题、活动时间和运行状态。 |
| `magi_dsh_review` | 执行只读独立外审，返回 `PASS`、`FAIL`、问题、未知项及审查环境限制。 |

讨论默认使用 `steer`：DSH 在当前回合的下一步边界接收消息，空闲时启动回合。只有明确希望排队时才使用 `followup`；`inject` 只补充上下文，不唤醒空闲会话。

DSH 回推默认通过 Codex 桌面的 `send_message_to_thread` 入口发送。来源线程和桌面端点由 `magi_ask_dsh` 自动登记；项目只提交正文和明确来源线程，不能指定发送模式。发送失败或结果不确定时会报错，不自动重试或退回排队。

## 安装与连接

需要可运行插件的 DSH、Codex 桌面应用，以及支持 ESM 和 `node:zlib` Zstandard 接口的 Node.js。外审还需要本机可用的模型凭据。回推依赖 Codex 桌面随附的 `codex-app-tools` MCP。

1. 在适合停止相关任务的窗口安装版本包：

   ```text
   dsh plugin --profile <配置名> add file:<安装包绝对路径>
   ```

   如果配置由桌面应用独占管理，请使用应用支持的插件管理流程。修改热重载配置前应停止 DSH，并备份配置、依赖清单和锁文件。

2. 重启 DSH，使宿主插件载入新代码。仅替换磁盘文件不能证明运行进程已升级。
3. 在 Codex 的 `config.toml` 中注册 MCP，然后重启 Codex：

   ```toml
   [mcp_servers.magi]
   command = '<Node.js 可执行文件绝对路径>'
   args = ['<插件目录>\lib\mcp-server.mjs']
   env_vars = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_HOME']
   tool_timeout_sec = 1800

   [mcp_servers.magi.tools.magi_ask_dsh]
   approval_mode = "approve"

   [mcp_servers.magi.env]
   DSH_HOME = '<DSH 数据目录>'
   ```

   `env_vars` 负责向 MCP 传递本次桌面端点和来源信息。不能把某次运行的管道地址写死进配置。

4. 在 DSH 打开目标会话，用 `magi_dsh_sessions` 核对后，通过 `session`、`node` 或 `title` 定位。
5. 检查目标 DSH 日志和 Codex 线程里的实际入站正文，完成双向验收。

Windows 原生 Sidecar 的连接要求和定向发送命令见 [运行说明](OPERATIONS.md)。

## 会话定位

定位优先级为 `session` → `node` → `title` → 项目当前节点路由 → 默认路由 → 工作区最近会话。

显式指定的会话、路由标签或标题若不存在、匹配多项或已关闭，桥会拒绝并返回原因，不改投到其他目标。正式使用时优先明确来源与收件会话；会话 UUID 属于本机状态，不能跨机器照抄。

回复应使用提问框架中的来源线程：

```text
node <插件目录>/lib/reply.mjs --thread <来源线程 UUID> --message-file <正文文件>
```

回推要求明确来源线程，不接受 `--project`、`--title` 或 `--mode`。项目不得另行调用 CLI 队列。

## 独立外审

外审阶段包括 `PHASE0`（方案）、`RED`（预期失败）、`GREEN`（实现与测试）和 `FINAL`（集成候选）。调用方声明目标、审查条款、候选路径、测试命令与证据。

- `candidate_paths` 限定参与指纹计算的代码和测试，避免把日志、审查输出纳入候选。
- 桥先运行声明测试，再把原始输出交给只读审查者；审查者只能执行声明范围内的命令。
- 裁决绑定 `package_id`、随机 `nonce` 和候选指纹；候选在审查过程中变化会被记录。
- 有问题或未知项时不能判为 `PASS`。只读环境无法执行的验证单列为 `structural_limits`，不能伪装成已验证事实。
- 普通讨论回复不构成正式审查证据。

## 运行边界与隐私

宿主只监听本机回环地址。发现文件包含访问令牌，路由文件、会话日志、桌面端点登记和审查证据均属于本机运行数据，不应提交到仓库或打进安装包。

受理回执只证明请求被接纳。是否送达，要看目标会话的实际入站记录；是否完成处理，要看后续执行结果。`MALFORMED_RESPONSE` 等模型错误应按提供方配置处理，插件升级不会自动修改用户的重试策略。

项目说明、安装包内容和测试不含真实会话 ID、个人称呼或本机用户目录。示例使用占位符和合成数据；协议字段、命令、错误码及标准许可证名称保留原拼写。

详细结构见 [架构说明](ARCHITECTURE.md)，配置、验证和排障见 [运维说明](OPERATIONS.md)。许可证为 [MIT](LICENSE)。
