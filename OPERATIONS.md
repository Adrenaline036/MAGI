# 安装与运维

## 配置前检查

确认正在使用的 DSH 数据目录、配置名和插件目录。优先读取 `DSH_HOME`，不要把其他安装或旧配置的数据目录当成当前实例。运行中的 `cordis.patch.yml` 可能实时重载，修改前应停止应用并备份。

安装包通过 DSH 支持的插件安装流程加载。升级后重启 DSH，并查询健康接口返回的已加载版本。安装包版本、磁盘文件版本和运行进程版本是三个不同的核验对象。

## Codex MCP

```toml
[mcp_servers.dshCollab]
command = '<Node.js 可执行文件绝对路径>'
args = ['<插件目录>\lib\mcp-server.mjs']
env_vars = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_HOME']
tool_timeout_sec = 1800

[mcp_servers.dshCollab.tools.ask_dsh]
approval_mode = "approve"

[mcp_servers.dshCollab.env]
DSH_HOME = '<DSH 数据目录>'
```

修改后重启 Codex 或重新启动 MCP。绝对入口路径应指向已核验的同一版本文件。`env_vars` 传递桌面端点和来源信息；只改入口路径不足以启用自动登记。

`CODEX_HOME` 未设置时使用用户目录下的 `.codex`。不要在配置中写入固定桌面管道地址，它会随应用重启变化。

## 定位与标签

先通过 `dsh_sessions` 核对会话，再在 `ask_dsh` 中传 `session`、`node` 或 `title`。标题完全匹配优先，其次要求包含匹配唯一；会话 UUID 前缀也必须唯一。

路由文件示例：

```json
{
  "version": 1,
  "projects": {
    "/path/to/project": {
      "node": "maintenance",
      "routes": { "maintenance": "<session-id>", "default": "<session-id>" }
    }
  }
}
```

在 DSH 会话内执行 `node <插件目录>/lib/cli.mjs label --as maintenance`，可用该会话导出的 `DSH_SESSION_ID` 注册标签。加 `--current` 才切换项目当前节点。

## 回复回推

```text
node <插件目录>/tools/transport/push-to-codex.mjs --thread <来源线程 UUID> --message-file <正文文件>
node <插件目录>/tools/transport/push-to-codex.mjs --title "<明确指定的对话标题>" --message-file <正文文件>
```

正文原样保留，尾部附 `[DSH]` 来源标记。默认 `steer` 使用桌面发送入口；需要等当前回合结束时显式加 `--mode followup`。

默认讨论回推拒绝仅用 `--project` 选择最近会话。排队模式保留项目选择器，但对已有提问的回复仍应使用来源线程。

`ask_dsh` 会自动登记来源线程和当前桌面端点。旧 MCP 尚未重新启动时，可以在目标 Codex 对话的 shell 中手动登记：

```text
node <插件目录>/tools/transport/push-to-codex.mjs --register-desktop --thread <线程 UUID>
```

该命令必须运行在具有当前 Codex 桌面环境的进程中。跨重启验收时不要手工登记，否则无法证明自动路径有效。

回执 `accepted` 只表示桌面受理；`queued` 表示明确使用了排队路径。遇到结果未知的错误，先检查目标线程中的正文，避免重复发送。

## 外审

声明 `project`、`stage`、`objective`、`obligations`、`candidate_paths` 和 `evidence`。`RED` 需要预期失败及测试命令；`GREEN`、`FINAL` 需要已执行的测试且不能声明预期失败。

测试命令必须是可独立执行的普通命令，避免混用 PowerShell 专有语法。优先提供与改动相关的定向测试。测试预算默认 180 秒、上限 600 秒；外审预算默认 600 秒、上限 1500 秒。Codex 工具超时需覆盖外审预算。

审查者使用只读沙箱。声明之外的命令会被拒绝，不能把这种拒绝直接视为插件误拒。审查环境的结构限制会单独记录；作者执行的补充验证应明确来源。

模型路由优先使用 `DSH_COLLAB_REVIEW_PROVIDER` 和 `DSH_COLLAB_REVIEW_MODEL`。未显式指定时，桥检查本机是否存在账号授权，再选择可用的 DSH 路由；不会输出凭据内容。

## 诊断接口

宿主只监听 `127.0.0.1`，除 `/health` 外都要求 Bearer 令牌。使用 CLI 可避免把令牌写进命令或日志：

```text
node <插件目录>/lib/cli.mjs health
node <插件目录>/lib/cli.mjs sessions --project <项目绝对路径>
node <插件目录>/lib/cli.mjs routes
```

| 接口 | 用途 |
|---|---|
| `GET /health` | 查看进程、已加载版本和活动会话。 |
| `GET /sessions?project=<路径>` | 查看项目会话。 |
| `GET /routes` | 查看路由。 |
| `POST /route` | 登记路由，`current: false` 可避免切换当前节点。 |
| `POST /node` | 切换当前节点。 |
| `POST /ask` | 投递问题及可选来源线程、选择器和模式。 |

`target_not_live` 表示目标会话尚未打开；`title_ambiguous` 或 `session_prefix_ambiguous` 表示定位不唯一。按返回的候选核对目标，不要自动改投。

## 验证

源码中的离线测试：

```text
node test/codex-desktop-delivery.test.mjs
node test/review-execution-guard.test.mjs
node test/bridge.test.mjs
node test/review-bridge.test.mjs
```

前两组为定向测试。后两组会创建并清理临时夹具；如果本机规定删除必须进入回收站，应先使用符合该规定的测试执行环境，不能直接运行清理步骤。

实机验收应确认：新进程加载了目标入口；正常 `ask_dsh` 自动生成匹配当前桌面的端点；DSH 日志有对应的 `plugin:collabridge` 入站；Codex 目标线程出现完整回复；运行中的回合无需结束即可接收。

依赖重装验证需在停机窗口执行 `pnpm install --frozen-lockfile`，比较执行前后的依赖记录和安装文件。解析成功或文件暂时一致不能替代这项验证。

## 发布与隐私

发布内容按白名单确定。排除本机路由、发现文件、端点收据、凭据、对话正文、审查记录、个人交接和临时诊断脚本。检查当前文件、安装包及 Git 历史；删除当前文件里的信息不会自动清理历史提交。

项目说明、工具参数说明和示例使用中文。协议标识符、命令、错误码、源码标识符及 MIT 许可证原文保留原拼写。示例中的路径、线程和令牌必须是占位符或明显的合成数据。
