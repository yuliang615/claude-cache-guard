# Claude Cache Guard — 参考文档

`claude-cache-guard`（CLI：`ccg`）的详细参考。[README](../README.zh-CN.md) 介绍安装与日常使用；本文档收录完整的命令、配置、数据与行为参考。运行 `ccg help` 即可查看完整的命令与选项一览。

- [Commands](#commands)
- [Configuration](#configuration)
- [Data stored](#data-stored)
- [The handoff](#the-handoff)
- [Hook behavior](#hook-behavior)
- [check-threshold](#check-threshold)
- [How it works](#how-it-works)

## Commands

| Command | What it does |
|---|---|
| `ccg install [--reconfigure] [--five-hour-warning N]` | 备份 `~/.claude/settings.json`，只修补 `statusLine`，在缺失时创建全局配置，并把 `/ccg*` slash command 装进 `~/.claude/commands/`（从下一个 Claude Code session 起，每个项目都能用——新的 `claude` 进程；`/clear` 不会重新载入）。`--reconfigure` 会在已有配置上重写阈值。 |
| `ccg uninstall [--remove] [--rmconfig] [--restore-backup <file>]` | 完整恢复到安装前的状态：先处理 statusLine（默认恢复原来的，`--remove` 直接移除，`--restore-backup` 恢复指定的备份），移除 `usage-state.json` 与整个 `~/.claude/cache-guard/` 目录，并移除 `~/.claude/commands/` 下全局的 `/ccg*` slash command（你自己写的同名文件不会动）。交接文件会被保留。`--rmconfig` 仍可用但已多余——默认就会移除全局配置。 |
| `ccg enable [--force]` | 启用当前项目：写入 `.claude-cache-guard.json`、`Stop`+`PostToolBatch` hook、一份起始交接文件，以及 `.claude/ccg-handoff.md`（附带一份干净的 `.claude/ccg-handoff.md.bak`）。同时清掉旧版本留下的项目本地 `.claude/commands/ccg*.md`——slash command 现在改由 `ccg install` 全局安装。配置与文件立即生效；hook 在 Claude Code v2.1.169 及以上会自动重新加载（更早的版本需要开新 session）。`--force` 会覆写交接文件（先生成带时间戳的 `.bak`）。 |
| `ccg disable [--rmhandoff]` | 移除本项目的配置、hook 与 hook 状态（顺带清掉旧版本残留的项目本地 `ccg*.md` slash command）。除非指定 `--rmhandoff`，否则保留交接文件。 |
| `ccg setting [--five-hour-warning N] [--on-warning auto\|ask]` | 设置按项目的覆写。非 TTY 环境下至少需要一个 flag。 |
| `ccg status` | 报告项目状态、用量、阈值、hook 提醒状态以及一条建议。 |
| `ccg usage` | 打印最新的用量快照。 |
| `ccg handoff` | 为已启用的项目打印交接 prompt。 |
| `ccg resume` | 发出一条 resume 指令（仅限 Claude Code；优先使用 `/ccgresume`）。 |
| `ccg config <path\|show>` | 显示全局配置的路径或内容。 |
| `ccg check-threshold [--five-hour N] [--seven-day N] [--json]` | 只读的阈值检查，带可脚本化的退出码。 |
| `ccg doctor` | 对 statusLine 接线、usage-state 新鲜度以及本项目 hook 的只读诊断。 |
| `ccg debug` | 转储本地 guard/hook 状态（仅布尔值与时间戳）。 |

### Install threshold

首次运行时 `ccg install` 会设置 5 小时警告阈值。交互式终端会提示输入（默认 `90`）；非交互式 shell 与 CI 使用 `90` 或显式的 `--five-hour-warning`：

```sh
ccg install --five-hour-warning 90
```

要在之后重新选择阈值，可以直接执行 `ccg install --reconfigure`，或者移除后重装——`ccg uninstall` 现在本来就会把全局配置一起恢复掉，不需要额外的 flag：

```sh
ccg uninstall
ccg install
```

交互式终端会再次提示输入，默认值为当前阈值；非交互式 shell 则需要显式指定 `--five-hour-warning`——若在非 TTY 环境中单独执行 `ccg install --reconfigure`，会报错 `ccg install --reconfigure requires --five-hour-warning when stdin/stdout is not interactive`，而不会静默把阈值重设为 `90`。（首次安装不受影响：非交互式的首次运行仍会默认使用 `90`。）

### Uninstall flags

```sh
ccg uninstall                                    # fully restore to the pre-install state
ccg uninstall --remove                           # drop the guard statusLine instead of restoring the previous one
ccg uninstall --rmconfig                         # accepted but redundant — the config is already removed
ccg uninstall --restore-backup <path-to-backup>  # restore an exact backup instead
```

每种形式都会先备份 `settings.json` 再改动它，接着处理 statusLine——默认恢复安装前的那个、`--remove` 直接移除、`--restore-backup` 恢复指定的备份文件——然后移除 `~/.claude/usage-state.json` 以及整个 `~/.claude/cache-guard/` 目录（全局配置、install state、hook 状态、日志、备份）。这样机器就回到 `ccg install` 运行之前的样子。`~/.claude/next-session/` 下的交接文件不受影响——那是项目内容，不是安装留下的状态。如果当前的 statusLine 不是 guard 的，就没有什么可恢复的，`settings.json` 会保持不变，也不写入备份。`--rmconfig` 单独使用时已经不会改变任何行为，因为默认就会移除配置——保留这个 flag 只是为了让旧脚本继续能用。

### Settings reconciliation

更改阈值会立即对当前的 hook episode 进行核对（reconcile）。如果某次交接已在较低阈值时触发，而新阈值高于当前的 5 小时用量，`ccg setting` 会立刻重置旧的触发状态——无需等待窗口重置；hook 即可在新阈值下再次触发。如果当前用量仍然达到或超过新阈值，则现有的触发状态保持激活。

### `ccg status` fields

`ccg status` 显示：项目是否已启用、保存的元数据是否仍与当前路径匹配、项目 id、交接路径、交接文件是否存在、是否启用了自定义交接指引、5 小时 / 7 天用量、阈值状态、交接模式（`auto` 或 `ask`）、hook 是否已安装、hook 提醒状态以及一条建议。hook 提醒状态为下列之一：`not sent`、`waiting for main Claude handoff`、`handoff complete for this usage window; project quiet`（在 ask 模式下则为 `asked the user once this usage window; project quiet`）、`reset` 或 `disabled`；激活状态还会显示模式、首次触发该 episode 的会话、触发事件、提醒次数、更新时间、用量、处理时间以及 hook 状态路径。

## Configuration

### Global config

```text
~/.claude/cache-guard/config.json
```

```json
{
  "version": 1,
  "thresholds": {
    "five_hour_warning": 90,
    "seven_day_warning": null
  },
  "handoff": {
    "storage_dir": "~/.claude/next-session",
    "file_name": "next_session.md",
    "mode": "manual",
    "max_lines": 220
  },
  "actions": {
    "on_warning": "auto_handoff"
  }
}
```

`actions.on_warning` 控制用量达到警告阈值时的行为：

- `auto_handoff`（默认）：hook 让 Claude 立即写交接文件，文件写好后停止当前目标，使工作在全新会话中继续。
- `ask`：hook 会询问用户如何处理，并且绝不会自动停止。它是每次"越过阈值"询问一次，而不是每个窗口只问一次——一旦用量回落到阈值以下、之后又再次越过阈值，就可能再次询问。

`actions.usage_max_age_seconds`（可选）设置用量新鲜度窗口（秒）：若 `usage-state.json` 的 `updated_at` 早于该值，hook 会将读数视为陈旧并不做任何事。默认为 `900`（15 分钟），`ccg install` 不会写入它——需手动添加以覆盖。

旧值 `suggest_handoff` 仍被接受，行为等同于 `auto_handoff`。`ccg install` 仅在该文件缺失时创建它，绝不覆写已有配置。

### Project config

`ccg enable` 在项目根目录写入 `.claude-cache-guard.json`：

```json
{
  "version": 1,
  "enabled": true,
  "project_name": "my-project",
  "project_id": "my-project--1234abcd",
  "handoff": {
    "file": "~/.claude/next-session/my-project--1234abcd/next_session.md"
  },
  "overrides": {}
}
```

按项目的覆写位于 `overrides` 下：

```json
{
  "overrides": {
    "thresholds": {
      "five_hour_warning": 60
    },
    "handoff": {
      "max_lines": 150
    }
  }
}
```

### Merge priority

```text
built-in defaults < global config < project overrides < CLI flags
```

## Data stored

`~/.claude/usage-state.json` 被白名单限定为恰好这些字段——绝不会存储任何 token、认证信息、transcript、prompt 或工具输入：

```json
{
  "source": "claude-code-statusLine",
  "updated_at": "2026-06-13T12:00:00.000Z",
  "model": { "id": "claude-opus-4-6", "display_name": "Opus 4.6" },
  "context_window": { "used_percentage": 42 },
  "five_hour": { "used_percentage": 75, "resets_at": "2026-06-13T17:00:00Z" },
  "seven_day": { "used_percentage": 31, "resets_at": "2026-06-18T09:00:00Z" }
}
```

项目 hook 状态（位于 `~/.claude/cache-guard/hook-state/` 下）还会额外记录首次触发提醒的 Claude Code `session_id`，用于诊断，以及在用量持续高于阈值期间在项目级别抑制重复。

## The handoff

交接文件存放在项目仓库之外：

```text
~/.claude/next-session/<project-id>/next_session.md
```

`<project-id>` 为 `<sanitized-project-name>--<8-char-path-hash>`。名称来自工作目录的 basename；哈希来自规范化的绝对路径，因此位于不同文件夹中的同名项目会获得各自不同的 id，而目录名也永远不会包含完整路径。`ccg enable` 在缺失时创建该目录及一份起始的 `next_session.md`，并且绝不覆写已有文件，除非传入 `--force`（此时会先备份旧文件）。

### Starter template

```md
# Next Session Handoff

## Snapshot
- Updated At: 2026-06-13T12:00:00.000Z
- Project: my-project (my-project--1234abcd)
- Working Directory: /path/to/my-project
- Current Goal:
- Current Status: Initialized by claude-cache-guard. Replace this starter template with a complete handoff when work needs to continue in a future session.

## Original User Prompts
<!-- Every distinct user instruction, VERBATIM and in order (slash commands and arguments exactly as typed). Do not summarize or paraphrase: compaction changes the meaning, so this is the un-compacted source of truth. -->

## What Changed

## Current State

## Decisions And Rationale

## Files And Artifacts

## Commands And Verification

## Open Questions

## Risks And Caveats

## Do Not Repeat

## Next Steps
1.
2.
3.

## Resume Prompt

You are continuing work on this project. Read this handoff file first, verify the current repository state before editing, continue from "Next Steps", respect the safety constraints, and avoid redoing completed work unless verification shows it is necessary.
```

Current Status 中的起始标记 `Initialized by claude-cache-guard.` 是 hook 用来判断"这份起始模板是否已被真正的交接内容替换"的依据：只要这段文字还在，hook 就会认定这个用量窗口的交接尚未写入。

`ccg handoff` 打印一份结构化的 prompt，包含针对角色、目标文件、项目上下文、流程、安全规则、输出契约与质量标准的明确小节。它要求 Claude 只读取当前工作所需的上下文，并写出一份简洁的、用于替换的 `next_session.md`；当存在旧的交接文件时，prompt 仅将其用作素材，并整体覆写整个文件（绝不就地追加或打补丁）。

### Custom handoff guidance

`ccg enable` 会在项目里创建 `.claude/ccg-handoff.md`——里面预先只写了一段说明用的 HTML 注释，没有其他内容——旁边还会附一份干净的 `.claude/ccg-handoff.md.bak`。编辑 `.claude/ccg-handoff.md`，在注释下方加上自己的提醒，一行一条，就能把项目专属的指引追加到标准交接 prompt 之后；注释块本身不生效，所以只有注释的文件算是未启用。也可以直接跟 Claude 说你想加什么提醒——起始注释里就注明了 Claude 可以应你的要求编辑这个文件。如果不小心把文件改坏了，把 `.claude/ccg-handoff.md.bak` 复制回去盖掉就能重新开始。

其内容是被追加的，绝不是被替换的：输出契约、安全规则以及逐字记录的 "Original User Prompts" 始终优先，因此自定义内容无法破坏 resume 或完成检测。当该文件生效时，`ccg status` 会显示 `handoff guidance: active`；空文件（或只有注释的文件）会被忽略。

## Hook behavior

- **Events:** Claude Code 的 `Stop` 和 `PostToolBatch`。`PostToolBatch` 覆盖那些较长的 `/goal` 运行——其中 Claude 在最终停止之前会贯穿多个工具批次继续运行。
- **Trigger:** 当前项目的有效 5 小时用量达到警告阈值。
- **Scope:** 状态按项目、按 5 小时用量窗口各跟踪一次。某个项目在一个窗口内被处理过一次后，无论当前是哪个会话激活，它在该窗口内都保持静默。不同项目相互独立。
- **Window identity:** 窗口由真实用量数据的 `five_hour.resets_at` 标识，而非 wall-clock 时间。提前重置或新订阅会改变 `resets_at`，被视为一个可以再次警告的新窗口。已处理过的窗口在用量回落到阈值以下后也会重新就绪（re-arm）。
- **Freshness:** hook 仅基于新鲜的用量行动。如果 `usage-state.json` 的 `updated_at` 早于新鲜度窗口（默认 15 分钟），hook 什么都不做，因此一个陈旧的高百分比无法在用量可能已经重置之后再触发。
- **Main-agent only:** 含 `agent_id` 的 hook 调用是子 agent 调用，会被忽略——子 agent 不能认领提醒，也不能覆写项目的交接文件。
- **Stale guard:** 如果 `five_hour.resets_at` 已经过去，存储的百分比被视为陈旧，hook 会等待刷新。
- **Auto mode:** 主 Claude agent 收到 `ccg handoff` prompt，并被要求直接对确切的目标路径使用 `Write` 工具来完整替换交接文件；一旦写好，hook 就停止该目标。
- **Ask mode:** hook 会询问用户如何处理，并且绝不会自动停止。它是每次"越过阈值"询问一次：询问之后，只要用量在该窗口内仍维持在阈值之上，就会保持安静；如果用量回落到阈值以下、之后又再次越过阈值，就可能再次询问。

hook 绝不会直接调用 Claude，也不会写 `next_session.md`、push、publish 或 deploy。在 auto 模式下，它注入指令、检查磁盘上的文件是否完成，然后停止该目标；在 ask 模式下，它把选择呈现给用户。

## check-threshold

`ccg check-threshold` 是用于脚本化的只读检查器。它读取 `~/.claude/usage-state.json` 与有效配置（全局 + 项目覆写），并且不读取 stdin、不扫描无关的 `~/.claude` 文件、不安装 hook、不更改设置，也不创建 `next_session.md`。

```sh
ccg check-threshold
ccg check-threshold --five-hour 90
ccg check-threshold --seven-day 80
ccg check-threshold --json
```

| Condition | status | exit |
|---|---|---|
| `five_hour.used_percentage < threshold` | `ok` | `0` |
| `five_hour.used_percentage >= threshold` | `warning` | `1` |
| invalid flag value | (error) | `2` |
| `five_hour.resets_at` already passed | `stale` | `3` |
| missing state / invalid JSON / missing `used_percentage` | `unavailable` | `3` |

五小时阈值取自有效配置（先项目覆写，否则全局，否则默认 `90`）；`--five-hour` 仅针对单次运行覆写它。`--seven-day` 会在 JSON 中报告以备将来的自动化使用，但不影响退出码——5 小时窗口才是激活的关卡。

JSON output:

```json
{
  "status": "warning",
  "five_hour": { "used_percentage": 91, "threshold": 90 },
  "seven_day": { "used_percentage": 22, "threshold": null },
  "message": "You should update next_session.md soon."
}
```

## How it works

Claude Code 的 statusLine 命令在 stdin 上接收一个 JSON 对象，并在 stdout 上打印要渲染的状态行。安装进 `~/.claude/settings.json` 的命令是：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/path/to/claude-cache-guard/bin/claude-cache-guard.js\" statusline",
    "padding": 0
  }
}
```

在每次 statusLine 刷新时，guard：

1. 从 stdin 读取 Claude Code 的 statusLine JSON。
2. 只提取白名单内的用量字段。
3. 以原子的 temp-file-and-rename 写入方式写 `~/.claude/usage-state.json`。
4. 若曾保留了上一个 statusLine 命令，则用相同的 JSON 输入运行它。
5. 回退到一个紧凑的默认显示：

```text
Opus 4.6 | ctx 42% | 5h 75% reset 2026-06-13T17:00:00Z | 7d 31% reset 2026-06-18T09:00:00Z
```

如果缺少 `rate_limits`，guard 不会崩溃：

```text
Opus 4.6 | ctx 42% | 5h n/a | 7d n/a | rate_limits unavailable
```

## References

- [Claude Code statusLine docs](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching and compaction docs](https://docs.claude.com/en/docs/claude-code/prompt-caching)
