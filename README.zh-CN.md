# Claude Cache Guard

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

`claude-cache-guard`（CLI：`ccg`）是一个纯本地的 Claude Code 用量防护工具。它会在 5 小时用量窗口用尽前，让 Claude 先把进度写成一份精简的交接文件（`next_session.md`），你就能在全新的小会话接续工作——**不必把旧对话当成 uncached（未缓存）token 重读，也不像 `/clear` 那样丢失细节**。

为什么需要它：Claude Code 每回合都会重送整段对话，平常靠 prompt cache 吸收这笔成本；但在等一个用尽的窗口重置的期间，cache 早就失效了。这时恢复庞大的会话，**整段对话会被当成没进过 cache 的输入 token 重新读一遍、全额算进你的用量，而且全发生在实际开始工作之前**——本来就有限的可用量，所剩无几。

## 快速开始

### 第 1 步——安装（每台机器一次）

```sh
npm install -g claude-cache-guard
ccg install
```

安装过程只会问一个问题：

```text
At what 5-hour usage percentage should Claude start preparing next_session.md? [90]:
```

按 **Enter** 采用默认值（`90`），或输入 `1` 到 `99` 之间的数字——之后随时可以按项目调整。

> [!IMPORTANT]
> 装完请**重新启动 Claude Code——退出后重新执行 `claude`**（或在 app 里开新 session），`/ccg*` slash command 才会载入，之后每个项目都能用。`/clear` **不够**——它只清空对话，不会重新载入命令。

若不用 npm，改从源码安装：

```sh
git clone https://github.com/yuliang615/claude-cache-guard.git && cd claude-cache-guard && ./scripts/install.sh
```

### 第 2 步——对项目启用

在项目目录启动 `claude`，然后执行：

```text
/ccgenable
```

这样就完成了——这个项目的交接工作流已经启用。Claude Code v2.1.169 及以上立即生效；更早的版本需要开一个新 session 才会完全生效（命令也会打印这条提示）。偏好终端的话，在项目目录跑 `ccg enable` 效果相同。它实际设置了哪些东西，见下方「工作原理」。

### 第 3 步——照常工作

当 5 小时用量到达阈值，ccg 会要求 Claude 写一份精简的 `next_session.md`，并结束当前任务——这一步你不用做任何事。阈值与警告行为可在下方「项目专属设置」自定义。

### 第 4 步——接续工作

窗口重置后，开一个**新的** Claude Code 会话（或在原会话先 `/clear`），执行：

```text
/ccgresume
```

Claude 会自动读取交接文件并接手工作，不必重读旧的会话。

> [!IMPORTANT]
> `/ccgresume` 请在全新的会话执行。回到原本那个庞大的旧会话继续，整段对话又会被当成 uncached token 重读一遍——交接省下的额度就白费了。

## 项目专属设置（Per-project settings）

启用项目之后，在 Claude Code 里用 `/ccgconfig` slash command 为该项目自定义交接阈值与警告行为。不带选项直接执行，会先显示当前设置值，再弹出原生选单——5 小时阈值提供 **90 / 95 / 97 %** 三个选项（选「Other」可自填 1–99），加上警告模式——选完自动应用：

```text
/ccgconfig
```

要直接改、或想写成脚本，就带选项执行，会跳过选单直接应用。（终端的 `ccg setting` 命令吃相同的选项；在 Claude Code 里打 `! ccg setting ...` 则完全不经过模型、立即执行。）

### 阈值

默认阈值是 90%。若要为单一项目调低（或调高），不用选单、直接下命令：

```text
/ccgconfig --five-hour-warning 70
```

当 5 小时用量到达这个百分比，交接流程就会启动。

### 警告模式（`--on-warning`）

`--on-warning` 控制用量到达阈值时的行为，有两种模式：

`auto`（默认）— ccg 自动送出交接 prompt 给 Claude。Claude 写完 `next_session.md` 后，ccg 会结束当前任务。整个过程不需要你手动操作，下一个会话直接从交接文件接续。

`ask` — ccg 会询问你要写交接并停止，还是继续工作。它绝不会自动停止。它是每次"越过阈值"询问一次，而不是每个窗口只问一次：询问之后，只要用量维持在阈值之上就会保持安静；如果用量回落到阈值以下、之后又再次越过阈值，就会再问一次。适合你还有剩余额度、想当下自己决定的时候。

```text
/ccgconfig --on-warning ask    # 切换到 ask 模式
/ccgconfig --on-warning auto   # 切回 auto 模式
```

两个选项可以在同一次命令中合并使用：

```text
/ccgconfig --five-hour-warning 70 --on-warning ask
```

覆写值存在项目的 `.claude-cache-guard.json` 里，立即生效。

### 自定义交接 prompt（进阶，用不到可跳过）

先说这个功能是干嘛的：用量快到阈值时，CCG 会请 Claude 把「做到哪、接下来要做什么」写进交接文件 `next_session.md`。如果你希望 Claude 每次写交接文件时多注意几件你在意的事——例如交接前一定要跑一次测试——就把提醒写进项目里的 `.claude/ccg-handoff.md`，之后每次交接都会自动带上。

最简单的做法是**直接用说的**：告诉 Claude 你希望交接时多注意什么，它就会帮你把提醒写进 `.claude/ccg-handoff.md`——文件里本身就注明了 Claude 可以应你的要求编辑它。想自己动手也可以：`ccg enable` 已经帮你建好 `.claude/ccg-handoff.md` 了，文件最上面有一段说明用的注释，那段注释会被忽略、不算提醒。在注释下面加你自己的提醒，一行写一条就好。

如果不小心把文件改坏了，旁边留了一份干净的备份 `.claude/ccg-handoff.md.bak`，复制回去盖掉就重新开始。

怎么确认生效：跑 `/ccgstatus`，看到 `handoff guidance: active` 就是生效了；空白文件（或只剩注释的文件）会被忽略。你的提醒只会「附加」在 CCG 标准交接指示的后面，不会取代它，所以不管写什么都不会弄坏恢复流程。

## Slash commands

`ccg install` 会把一组 slash command 装进 `~/.claude/commands/`，每个项目都能用——名称一律是 `ccg` + 对应的 CLI 子命令，中间不带连字符。只读命令会在命令展开时预先执行对应的 ccg 命令，再交给轻量模型汇报，所以响应快、几乎不消耗 token：

| 命令 | 功能 |
|---|---|
| `/ccgresume` | 在新的会话从交接文件接续工作 |
| `/ccgstatus` | 显示项目状态，包含阈值检查 |
| `/ccgusage` | 显示当前用量 |
| `/ccgdisable` | 停用这个项目的 ccg |
| `/ccghandoff` | 输出交接 prompt |
| `/ccgdebug` | 执行诊断并显示调试信息（会跑 `ccg doctor` 和 `ccg debug`） |
| `/ccgenable` | 启用（或重新启用）这个项目的 ccg |
| `/ccgconfig` | 调整项目设置——不带选项会弹出选单直接选；带选项（如 `--five-hour-warning 70`）直接应用 |

完整命令与选项见 [参考文档](docs/REFERENCE.zh-CN.md#commands)。

## 配置

全局默认值放在 `~/.claude/cache-guard/config.json`；每个项目的覆写放在该项目的 `.claude-cache-guard.json`。优先顺序是：内置默认 < 全局配置 < 项目覆写 < CLI 选项。

想看一个项目当前生效的设置——5 小时阈值、它来自哪里、以及当前的警告模式——运行 `/ccgstatus`。要调整就用 `/ccgconfig`，见上方「项目专属设置」。（终端对应命令：`ccg status`、`ccg setting`；`ccg config show` 可以打印全局配置的原始 JSON。）完整配置结构与合并规则见 [参考文档](docs/REFERENCE.zh-CN.md#configuration)。

## 它存储什么

本工具只写一个白名单文件 `~/.claude/usage-state.json`，只保留 `source`、`updated_at`、`model`、`context_window`、`five_hour`、`seven_day` 这几个字段。绝不存储任何 token、认证、对话记录、prompt 或工具输入，也不会有任何东西离开你的机器。完整结构见 [参考文档](docs/REFERENCE.zh-CN.md#data-stored)。

## 用量

在 Claude Code 里执行 `/ccgusage`（或终端的 `ccg usage`）：

```text
updated: 2026-06-13T12:00:00.000Z
model:   Opus 4.6
context: 42%
5h:      75% reset 2026-06-13T17:00:00Z
7d:      31% reset 2026-06-18T09:00:00Z
```

若 Claude Code 没有提供可用的 `rate_limits`，`usage` 与 `doctor` 会如实说明，且不会在 `usage-state.json` 加上额外字段。

## 疑难排查（Troubleshooting）

当有东西看起来不对劲时，在 Claude Code 里执行 `/ccgdebug`——它会跑完两项只读诊断，并解释找到的问题。（终端对应命令：`ccg doctor`、`ccg debug`。）

输出只有状态与时间戳，不包含 statusLine 命令内容、配置值或凭证。诊断会标出常见的设置问题：`statusLine` 是否指向本工具、`~/.claude/usage-state.json` 是否在更新、已启用项目的 hook 是否安装、以及是否有 hook 错误被记录。完整命令列表请跑 `ccg help`。

## 卸载（Uninstall）

```sh
ccg uninstall
```

`ccg uninstall` 会把电脑还原成安装前的样子：statusLine 还原、全局配置和用量状态清掉、全局 slash 命令移除（你自己写的同名文件不会动）。交接文件会留着（在 `~/.claude/next-session/`），毕竟那是你的工作记录。

`--remove` 只移除 statusLine、不还原旧的；`--restore-backup <path>` 还原指定的备份。`--rmconfig` 仍然接受，但已经不需要了——默认就会清掉全局配置；这两个选项见 [参考文档](docs/REFERENCE.zh-CN.md#uninstall-flags)。

## 工作原理

`ccg install` 对全局只改一件事：备份 `~/.claude/settings.json`、只修补其中的 `statusLine` 字段，并把 `/ccg*` slash command 复制到 `~/.claude/commands/`。（状态栏本身在下一次刷新就会生效——安装后要重启，是为了载入 slash command。）`ccg enable` 则严格限定在项目本地：在 `.claude/settings.local.json` 安装 `Stop` 与 `PostToolBatch` hook、写入项目配置，并创建起始的 `next_session.md` 与 `.claude/ccg-handoff.md` 提醒文件（见上方「自定义交接 prompt」）。

每次 statusLine 刷新时，本工具会从 stdin 读取 Claude Code 的 JSON、只抽取白名单用量字段、用「临时文件再改名」的原子写入方式写到 `~/.claude/usage-state.json`，然后渲染你原本的状态栏（或一个精简的默认显示）。项目 hook 会读这个文件，并在 5 小时用量跨过阈值时触发交接。statusLine 接线与完整 hook 行为见 [参考文档](docs/REFERENCE.zh-CN.md#how-it-works)；非交互式安装（阈值默认 `90`，可用 `--five-hour-warning` 覆写）等 install 选项见 [命令一览](docs/REFERENCE.zh-CN.md#commands)。

## 参考资料

- 📖 **完整参考：** [`docs/REFERENCE.zh-CN.md`](docs/REFERENCE.zh-CN.md) — 每个命令与选项、配置与数据结构、交接格式，以及完整的 hook 行为。执行 `ccg help` 即可查看完整的命令与选项一览。
- [Claude Code statusLine 文档](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code 设置文档](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching 与 compaction 文档](https://docs.claude.com/en/docs/claude-code/prompt-caching)（compaction 会重用已缓存的前缀）