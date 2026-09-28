# AGENTS.md

## 项目边界

本仓库是 DeepSeek Harness（dsh）的独立 OMP 风格 TUI profile bundle。终端呈现、输入、主题、设置和微信桥属于本仓库；agent、模型、工具、会话持久化与沙箱由 dsh harness 提供，不要在这里复制或修改上游实现。

`docs/contracts.md` 是当前 dsh `0.1.7-rc.2` 合约的唯一真相源。涉及 `@deepseek-ai/*` 接口、事件顺序、Profile 组合或依赖版本时，先完整阅读并更新该文件，再同步源码、`cordis.patch.yml`、依赖和测试。

## 目录与生成物

- `src/`：TUI、启动、提示、会话、设置和主题实现；`src/components/` 放可复用显示组件，`src/wechat/` 放微信桥。
- `tests/`：使用 Node `node:test` 的行为测试；测试直接导入 TypeScript 源码。
- `cordis.patch.yml`：本 bundle 在 dsh base profile 上的覆盖项与插入项。改变服务或入口时同时核对 `package.json` 的 exports、构建入口和此文件。
- `lib/`：由构建生成且被 Git 忽略；不要直接编辑或提交。
- `src/theme-data.ts`：由 `scripts/generate-omp-themes.mjs` 生成；不要手改。仅在有意刷新 OMP 主题目录时运行 `pnpm run generate:themes`，并审查完整差异。
- `.agents/skills/test-dsh-tui/`：真实终端测试工具。凡是启动、渲染、键盘输入、斜杠命令、补全、对话框、状态保留、进程连续性或 Profile 插件行为发生变化，必须先完整阅读其中的 `SKILL.md` 并按其选择测试层级。

## 环境与命令

使用 Node.js `^22.19.0` 或 `>=24.0.0`、pnpm 11；仓库锁定的包管理器版本为 pnpm `11.25.0`。

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run check
pnpm run prepare
```

`pnpm run check` 依次执行类型检查和全部源码测试。`pnpm run prepare` 从 `src/` 生成消费者使用的 `lib/` bundle，但不执行类型检查，因此不能替代 `check`。

本仓库中，用户说“安装”时，默认指打包后安装到本机 TUI Profile：先运行 `pnpm run prepare` 构建 `lib/`，再运行 `pnpm pack` 生成 `.tgz` 归档；安装前必须把归档复制或重命名为从未使用过的持久文件名（例如 `yoke233-omdsh-<version>-local-<timestamp>.tgz`），同版本重复安装也必须换名以绕过包管理器缓存；最后运行 `dsh plugin --profile tui add <改名后的 .tgz>`。完成标准是 `tui` Profile 使用本次生成且改名后的归档而非旧缓存或 `link:.`，并保留该归档供 Profile 后续解析。只有用户明确说“安装依赖”时才解释为 `pnpm install`。

运行单个测试文件：

```powershell
pnpm exec node --disable-warning=ExperimentalWarning --test --experimental-transform-types "tests/<name>.spec.ts"
```

## 变更与验证

- 修改纯业务逻辑或组件行为时，先运行对应的单文件测试，再运行 `pnpm run check`。
- 修改可见 UI 行为时，覆盖相关宽度、边界或状态转换，并按 `.agents/skills/test-dsh-tui/SKILL.md` 判断是否需要真实 ConPTY 测试；纯文本快照不能证明字体或像素颜色。
- 修改源码、构建入口、exports 或 `cordis.patch.yml` 后，运行 `pnpm run check` 和 `pnpm run prepare`；涉及真实 TUI/Profile 行为时再完成相应 live smoke。
- 修改发布内容或版本时，完整阅读 `docs/PUBLISHING.md`，运行 `pnpm pack --dry-run`，并确认 tag 为 `v<package.version>`。
- 用户要求提交并推送时，提交前运行一次 `pnpm run version:patch`，由包管理器递增 `package.json` 的 patch 版本；同一批变更只运行一次。除非用户同时要求发布，否则不要创建或推送 tag。
- 不要提交 API key、会话数据、微信状态目录或真实凭据；保留测试运行器为每次 live run 创建的隔离 `DSH_HOME`。

完成变更时，报告实际运行的测试与结果；区分源码测试、构建验证和打包后的真实终端测试。不要把未执行的 smoke 或发布检查描述为已通过。
