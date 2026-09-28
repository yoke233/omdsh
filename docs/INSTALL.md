# omdsh 安装与升级

本项目是 dsh profile bundle，不是独立的 dsh 实现；同时提供 `omdsh` 启动器。bundle 由 dsh profile 加载，启动器则调用系统 PATH 中的官方 `dsh`。

全局安装 tarball 只用于安装 `omdsh` 启动器；它不会单独提供 dsh runtime。

## 全局安装启动器
首选从 npm 安装作用域包，并保留 `--legacy-peer-deps`，禁止 npm 自动安装宿主 peer。宿主服务由官方 `dsh` 提供；仅将直接 peer 标为 optional 无法阻止 npm 安装传递 peer，复制 `settings`、`app-boot` 等宿主服务会使配置保存失败。启动器仍要求系统 PATH 中存在官方 `dsh`。

```sh
npm install --global --legacy-peer-deps @yoke233/omdsh
# 或安装下载到本地的 GitHub Release：
npm install --global --legacy-peer-deps ./yoke233-omdsh-0.6.9.tgz
```

随后安装官方 dsh（若尚未安装），再运行启动器：

```sh
npm install --global @deepseek-ai/dsh@0.1.7-rc.2
omdsh
```

如果只安装了 `@yoke233/omdsh` 而没有官方 `dsh`，运行 `omdsh` 时出现 `dsh is not recognized` 是预期错误；请先安装上面的官方 dsh。插件实际运行仍推荐使用下方的 `dsh plugin ... add`，由 tui profile 提供宿主依赖。

## 兼容性

| 项目 | 要求 |
|---|---|
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| pnpm | `11.25.0` 或兼容的 pnpm 11 |
| dsh | `0.1.7-rc.2` |
| 终端 | 支持 truecolor；Nerd Font 可获得完整图标显示 |

当前 dsh 仍处于 developer preview，升级 dsh 可能包含兼容性破坏变更。首次安装建议固定 dsh 版本和插件 release tag。

## 首选：安装 GitHub Release 资产

发布者会在 GitHub Release 中提供由 `pnpm pack` 生成的 tarball：

```sh
# 没有 pnpm 时，任选其一：
npm install --global pnpm@11.25.0
# 或：corepack enable

npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile tui add \
  https://github.com/yoke233/omdsh/releases/download/v0.6.9/yoke233-omdsh-0.6.9.tgz
```

tarball 已经包含构建后的 `lib/`，安装时不需要在用户机器上编译项目，也不会执行 Git 依赖的 `prepare` 构建流程。

## 直接从 GitHub tag 安装

Release 尚未创建或需要安装某个提交时，可以直接安装 Git 仓库。Git 依赖包含 `prepare` 构建脚本；pnpm 11 默认会阻止依赖构建脚本，因此必须显式允许本项目构建：

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile tui add \
  --allow-build=@yoke233/omdsh \
  github:yoke233/omdsh#v0.6.9
```

不要省略 `--allow-build=@yoke233/omdsh`。如果 pnpm 已打印了 `allowBuilds` 建议，也可以按提示将该精确包名写入 `~/.config/pnpm/rc` 或 profile 的 `pnpm-workspace.yaml` 后重试。

固定 tag 比直接使用 `#main` 安全、可复现；开发测试才使用：

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile tui add \
  --allow-build=@yoke233/omdsh \
  github:yoke233/omdsh#main
```

## 启动

如果使用 `npx`：

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 --profile tui
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 --profile tui --resume <session-id>
```

也可以安装 dsh launcher 后直接使用 `dsh`：

```sh
npm install --global @deepseek-ai/dsh@0.1.7-rc.2
dsh --profile tui
```

**推荐**使用本项目自带的 `omdsh` 启动器（它只从系统 PATH 中查找官方 `dsh`，不通过 npx 下载或缓存 dsh）。`omdsh` 首次运行时会自动把 `@yoke233/omdsh` 安装到 tui profile；已有安装只做本地完整性修复，普通启动不会比较或升级版本。版本升级必须显式运行 `omdsh update`（可用 `OMDSH_NO_BOOTSTRAP=1` 跳过引导与修复）。它还是 `/reload` 的监督进程：只有经 `omdsh` 启动，TUI 里的 `/reload` 才能原地重启插件运行时并续接当前会话。

全局安装 tarball（见上文）后 `omdsh` 直接在 PATH 中：

```sh
omdsh
omdsh --resume <session-id>
omdsh update          # 安装 GitHub 最新 Release 到 tui profile
omdsh update --force  # 即使版本相同也重新下载并安装
```

若只用 `dsh plugin add` 安装到 profile，`omdsh` 位于 profile 的 `.bin` 目录，可将其加入 PATH：

```sh
export PATH="$HOME/.dsh/profiles/tui/node_modules/.bin:$PATH"   # Git Bash / zsh
$env:PATH = "$HOME\.dsh\profiles\tui\node_modules\.bin;$env:PATH"  # Windows PowerShell
```

验证 profile 已组合成功：

```sh
dsh --profile tui --dump-config
```

输出中应包含 `@yoke233/omdsh` bundle，以及 `@yoke233/omdsh/startup`、`@yoke233/omdsh/prompt` 和 `@yoke233/omdsh` 行。

## 配置模型

官方 DeepSeek API：

```sh
# Git Bash / zsh
export DEEPSEEK_API_KEY='your-key'

# PowerShell
$env:DEEPSEEK_API_KEY = 'your-key'
```

本地 OpenAI-compatible 网关：

```sh
# Git Bash / zsh
export DEEPSEEK_BASE_URL='http://localhost:3000/v1'

# PowerShell
$env:DEEPSEEK_BASE_URL = 'http://localhost:3000/v1'
```

`cordis.patch.yml` 当前默认 agent 为 `deepseek-official/deepseek-v4-flash`。启动后可以用 `/model` 选择并持久化 provider、model 和 reasoning effort。

## 升级

启动器默认查询 npm 的 `latest` dist-tag，下载 tarball 并校验 registry 提供的 SHA-512 integrity，然后更新 `tui` profile：

```sh
omdsh update
```

从 DSH 0.1.6 升级时，首次启动会把旧 `settings.yaml` 中的平铺 TUI 主题/提示模板、`session-title` 模型及 `agent-presets.default` 迁移到 Profile 原生设置；原文件由 DSH 保留为 `settings.yaml.imported`。后续设置只写入 `profiles/tui/cordis.patch.yml`。

也可以用新的 release tarball 明确切换版本：

```sh
dsh plugin --profile tui add \
  https://github.com/yoke233/omdsh/releases/download/v0.6.9/yoke233-omdsh-0.6.9.tgz
```

如果系统中已经全局安装 `@yoke233/omdsh`，本地 tarball 升级必须把**同一个 tarball**同时安装到全局和 `tui` Profile。DSH 解析 bundle 时会先检查宿主 installation anchor；只更新 Profile 可能继续加载全局旧 bundle：

先卸载旧全局启动器以清理其私有 peer 副本；此操作不删除 `~/.dsh` 中的 Profile、设置、会话或凭据。

```sh
npm uninstall --global @yoke233/omdsh
npm install --global --legacy-peer-deps ./yoke233-omdsh-0.6.9.tgz
dsh plugin --profile tui add ./yoke233-omdsh-0.6.9.tgz
```

若当前依赖跟踪的是 `main`，可以更新 Git 依赖：

```sh
dsh plugin --profile tui update @yoke233/omdsh
```

经 `omdsh` 启动的运行中会话无需退出：安装新版后在 TUI 里执行 `/reload`，新一代进程会载入新版本并续接当前会话。

### 从旧包名迁移

`omdsh` 0.6.0 起 npm 包名由 `dsh-omp-tui` 迁移到 `@yoke233/omdsh`。先替换全局启动器，避免两个包同时提供 `omdsh` 命令：

```sh
npm uninstall --global dsh-omp-tui
npm install --global --legacy-peer-deps @yoke233/omdsh
omdsh
```

新启动器发现 `tui` Profile 仍引用 `dsh-omp-tui` 时，会先移除旧 bundle 再安装新包；session、设置和微信状态不会删除。自定义 Profile patch 若引用 `dsh-omp-tui/*`，需改为 `@yoke233/omdsh/*`。

升级后重新检查：

```sh
dsh --profile tui --dump-config
omdsh
```

## 卸载

```sh
dsh plugin --profile tui remove @yoke233/omdsh
```

这会从 profile 依赖和 `dsh.profile.bundles` 中同时移除该 bundle，不会删除已有 session 数据。

## 本地开发安装

```sh
git clone https://github.com/yoke233/omdsh.git
cd omdsh
pnpm install
pnpm run check
pnpm run prepare

# dsh 会把相对路径按调用目录解析；link 适合持续开发
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile tui add link:.
```

修改源码后运行 `pnpm run prepare`，link profile 会立即使用新的 `lib/`；经 `omdsh` 启动的会话中执行 `/reload` 即可原地载入新代码，无需退出终端。需要模拟发布拷贝时使用：

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile tui add file:.
```

## 微信桥（WeChat iLink）

本 bundle 同时安装微信桥服务。启动后使用：

```sh
/wechat-login      # 扫码登录
/wechat-pair <码>  # 批准微信配对码
/wechat-status     # 查看桥状态
/wechat-notify on  # 终端任务也推送微信
```

微信里以 `@dsh` 开头的消息为远程命令；普通消息会注入当前 dsh 会话。状态目录为
`~/.dsh/wechat-ilink/`（可用 `DSH_WECHAT_ILINK_STATE` 覆盖）。

## 常见问题

### `pnpm: command not found`

安装 `pnpm@11.25.0`，然后确认 `pnpm --version` 输出为 pnpm 11。

### Git 安装被阻止，提示 `allowBuilds`

重新运行安装命令，并保留：

```sh
--allow-build=@yoke233/omdsh
```

Git 安装会从源码执行 `prepare`，这是 pnpm 的供应链保护行为，不是 dsh 运行时错误。

### API 请求失败

确认 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_BASE_URL` 在启动 dsh 的同一个 shell 中可见；本地网关还必须提供兼容 `/v1` 的接口。

### 图标显示为方框

安装并启用 Nerd Font，然后重启终端。布局和功能不依赖 Nerd Font，但图标会回退为方框或普通字符。

### Windows 路径

PowerShell 使用上面的 `$env:...` 语法；Git Bash 可直接运行 `npx`、`pnpm` 和 dsh 命令。路径包含空格时用引号包住完整路径。


