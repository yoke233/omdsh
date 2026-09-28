# `/jobs` 命令与后台任务状态

## 当前实现

OMP TUI 提供 `/jobs`，展示当前前台 session 可见的后台任务；Background tasks 面板同时汇总子 Agent 与 Jobs。任务注册、owner 隔离、输出 ring、读取、取消和回收全部复用 `ctx.jobs`，本仓库只负责命令格式化与终端呈现。

DSH 0.1.7-rc.2 提供：

- `@deepseek-ai/dsh-jobs`：`ctx.jobs` 抽象服务与 `JobView`、`JobSpec`、事件流类型。
- `@deepseek-ai/dsh-jobs-local`：由 base profile 挂载的进程内 registry。
- `@deepseek-ai/dsh-tool-jobs`：模型侧 `job_list`、`job_output`、`job_kill` 工具。
- `@deepseek-ai/dsh-client-ui-jobs`：Web 专用表面，不直接复用于 TUI。

Registry 使用 `SessionId` 而不是 `Agent` 做访问隔离：

```ts
ctx.jobs.list(sessionId): JobView[]
ctx.jobs.get(id, sessionId): JobView
ctx.jobs.read(id, sessionId): JobRead
ctx.jobs.readAt(id, offset, sessionId): JobOutputRead
ctx.jobs.kill(id, sessionId, reason?)
ctx.jobs.wait(id, timeoutMs, sessionId, signal?): Promise<JobView>
ctx.jobs.remove(id, sessionId)
ctx.jobs.events.subscribe({ owner } | { owners: 'scope' | 'all' }, listener)
```

任务状态为 `running | stopping | completed | killed | failed`。事件流发送 `registered | progress | stopping | settled | removed | output`；`output` 只携带 ring 坐标，观察者通过 `readAt()` 从自己的绝对 byte offset 读取，不推进模型 cursor。

## `/jobs` 呈现

命令调用 `ctx.jobs.list(invocation.agent.id)`，因此沿用 registry 的 owner fence。展示顺序：

1. `running`、`stopping` 在前，按启动时间升序。
2. 已结束任务在后，按结束时间降序。

示例：

```text
后台任务（2 个运行中，共 4 个）

● pwsh-1      running    1m 23s  pnpm run check
◐ subagent-2  stopping     42s   Review command design
✓ pwsh-3      completed     8s   Run unit tests
✗ pwsh-2      failed        3s   Build package — exit code 1
```

每行包含 id、状态、持续时间、label 与可选 detail；没有任务时显示空状态。当前命令不提供 output/kill 子命令，模型和其他控制器继续使用 registry 原生接口。

## Background tasks 面板

面板通过 `ctx.jobs.events.subscribe({ owners: 'all' }, listener)` 监听生命周期和 output commit，再按事件的 `owner` 与当前前台 `SessionId` 决定是否刷新。任务列表来自 `ctx.jobs.list(foreground.id)`；`running` 和 `stopping` 视为活跃。

Jobs 与子 Agent 共用 Background tasks 面板，不在 footer 重复显示计数。空编辑器按下方向键展开列表，选择 Job 可查看其状态；按左方向键返回主 Agent 视图。订阅 disposer 随 TUI effect 生命周期释放。

## 行为覆盖

源码测试覆盖：

- 空列表、五种状态和 active 统计。
- 活跃任务优先、稳定排序及 settled 任务倒序。
- 秒、分钟、小时、天的持续时间边界。
- label/detail 单行规范化。
- `/jobs` 使用 `invocation.agent.id` 读取 owner 可见任务。
- Job 事件只刷新当前前台 owner 或无 owner 的任务。

真实 ConPTY 验证负责命令输入、面板导航、reload 后监听器不重复及窄终端布局。实现不得复制 registry 生命周期，也不得把可预测的 Job id 当成授权边界。
