# Hooks（Claude Code 兼容）

本 bundle 挂载了官方桥接插件 `@deepseek-ai/dsh-hooks-claude-code@0.1.7-rc.2`：
在 harness 的拦截缝上运行 Claude Code 格式 hooks 配置中的 command-hook 子集。
TUI 侧只在 hook 结果有信息量时渲染“Hook”卡片（阻断性决策
`deny`/`block`/`stop`/`ask`、非零 exit code 或有 stderr 输出；与工具卡一样受
Ctrl+O 折叠/展开控制）；纯 pass 的空跑只留在 session log，不占屏幕。拦截性
决策（`deny` / `block` / `stop`）会额外弹出警告通知。

## 启用方式（两层配置）

桥在 bundle patch 里挂载了两行，实现「项目级 + 用户级」分层（对齐各 agent CLI
把 hooks 放自己家目录的惯例：Claude Code 用 `~/.claude`、Cursor 用 `~/.cursor`、
Codex 用 `~/.codex`——dsh 的用户层放在 `~/.dsh`）：

| 层 | 路径 | 说明 |
|---|---|---|
| 项目级 | `./.claude/hooks.json` | 按进程启动 cwd 解析；可用 `OMDSH_HOOKS_CONFIG` 环境变量覆盖（例如指向某个含 `hooks` 键的 Claude Code settings.json） |
| 用户级 | `~/.dsh/hooks.json` | 跟随 `$DSH_HOME`；对该用户所有 dsh 会话生效 |

两层的 hook 都会在同一拦截缝上运行，任一层 `deny` 即阻断。每个路径都是
进程级、加载时读取一次，不支持热重载（改配置后 `/reload`）。文件缺失或损坏
是安全的：桥只写一条日志警告，不注册任何 hook。

刻意**不**自动读取 `~/.claude/settings.json`：那是 Claude Code 的用户配置，
里面的 hooks（如 Orca 的转发器）是按 CC 的工具名和会话语义写的，自动跑在
dsh 上会产生每次工具调用的子进程开销和未定义行为。确实需要时用
`OMDSH_HOOKS_CONFIG=~/.claude/settings.json` 显式开启。

## link: 开发安装注意

桥随 dsh 0.1.7-rc.2 宿主发布。通过 tarball /
registry 安装本 bundle 时，桥作为 bundle 的 dependencies 会被正常安装；但 profile
用 `link:` 指向本仓库开发时，pnpm 不会安装 link 包的依赖，需要把桥装成 profile
的直接依赖：

```sh
cd ~/.dsh/profiles/tui
pnpm add @deepseek-ai/dsh-hooks-claude-code@0.1.7-rc.2 @deepseek-ai/dsh-hook-protocol@0.1.7-rc.2 --config.auto-install-peers=false
```

（`auto-install-peers=false` 用于复用 dsh 0.1.7-rc.2 宿主提供的 peer，避免 profile
再安装一套 Cordis 与 harness 服务身份。）

## 示例

见 [examples/hooks.example.json](examples/hooks.example.json)。格式与 Claude Code
的 hooks 配置一致：stdin 收 JSON（`session_id`、`tool_name`、`tool_input` 等），
exit 2 阻断（stderr 为原因），或 stdout 输出 JSON 决策
（`permissionDecision: allow|deny|ask`、`additionalContext` 等）。

## 支持的事件与映射

| CC hook | harness 拦截缝 | 能力 |
|---|---|---|
| `SessionStart` | `agent/session-start` | 注入 additionalContext（不能阻断） |
| `UserPromptSubmit` | `agent/pre-step` | 阻断提示 / 注入上下文 |
| `PreToolUse` | `tools/pre-execute` | `deny` 阻断；`ask` 走 TUI 审批弹框 |
| `PostToolUse` | `tools/post-execute` | 阻断性反馈 / 注入上下文 |
| `Stop` | `agent/turn-stopping` | 阻断结束，强制续跑一步 |
| `SubagentStart` / `SubagentStop` | `subagent/start` / `subagent/end` | 注入 / 只读观测 |

## 注意事项

- **matcher 匹配的是 dsh 的工具名**（TUI 工具卡标题上显示的名字），不是
  Claude Code 的 `Bash`/`Edit`/`Write`。沿用 CC 老配置时 matcher 大多不会命中；
  match-all（空 matcher / `*`）的 hook 则照常运行。
- `PreToolUse` 的 `updatedInput` 不生效（dsh 有意禁止改写参数，保证日志与实际
  执行一致）；`allow` 不做预授权。
- `Stop` 没有连续阻断上限：无条件返回阻断的 Stop hook 会无限续步，需自行限制。
- 仅 `type: "command"` 的 hook 会运行；`http`/`mcp_tool`/`prompt`/`agent`
  类型解析后跳过并警告。多个命中 hook 串行执行，决策按最严合并
  （`deny > ask > allow`）。
- 每 hook 默认超时 600s，可用每条 hook 的 `timeout`（秒）覆盖。
- 完整限制清单见桥的 README：
  `node_modules/@deepseek-ai/dsh-hooks-claude-code/README.md`。
