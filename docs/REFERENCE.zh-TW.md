# Claude Cache Guard — 參考文件

`claude-cache-guard`（CLI：`ccg`）的詳細參考文件。[README](../README.zh-TW.md) 涵蓋安裝與日常使用；本文件則收錄完整的命令、設定、資料與行為參考。執行 `ccg help` 即可看到完整的指令與旗標一覽。

- [命令（Commands）](#commands)
- [設定（Configuration）](#configuration)
- [儲存的資料（Data stored）](#data-stored)
- [交接（The handoff）](#the-handoff)
- [Hook 行為（Hook behavior）](#hook-behavior)
- [check-threshold](#check-threshold)
- [運作原理（How it works）](#how-it-works)

## Commands

| Command | What it does |
|---|---|
| `ccg install [--reconfigure] [--five-hour-warning N]` | 備份 `~/.claude/settings.json`，只修補 `statusLine`，在全域設定不存在時建立它，並把 `/ccg*` slash commands 裝進 `~/.claude/commands/`（開新的 Claude Code session 起，每個專案都能用——新的 `claude` 行程；`/clear` 不會重新載入）。`--reconfigure` 會在既有設定上重寫門檻值。 |
| `ccg uninstall [--remove] [--rmconfig] [--restore-backup <file>]` | 完整還原安裝前的狀態：先處理 statusLine（預設還原原本的，`--remove` 直接移除，`--restore-backup` 還原指定的備份），移除 `usage-state.json` 與整個 `~/.claude/cache-guard/` 目錄，並移除 `~/.claude/commands/` 下全域的 `/ccg*` slash commands（你自己寫的同名檔案不會動）。交接檔會被保留。`--rmconfig` 仍可用但已多餘——預設就會移除全域設定。 |
| `ccg enable [--force]` | 啟用目前專案：寫入 `.claude-cache-guard.json`、`Stop`+`PostToolBatch` hooks、一份起始交接檔，以及 `.claude/ccg-handoff.md`（連同一份乾淨的 `.claude/ccg-handoff.md.bak`）。同時清掉舊版留下的專案本地 `.claude/commands/ccg*.md`——slash commands 現在改由 `ccg install` 全域安裝。設定與檔案立即生效；hooks 在 Claude Code v2.1.169 以上會自動重新載入（較舊版本需開新 session）。`--force` 會覆寫交接檔（先建立一份帶時間戳記的 `.bak`）。 |
| `ccg disable [--rmhandoff]` | 移除此專案的設定、hooks 與 hook 狀態（順便清掉舊版殘留的專案本地 `ccg*.md` slash commands）。除非加上 `--rmhandoff`，否則保留交接檔。 |
| `ccg setting [--five-hour-warning N] [--on-warning auto\|ask]` | 設定各專案的覆寫值。非 TTY 環境下至少需要一個旗標。 |
| `ccg status` | 回報專案狀態、用量、門檻、hook 提醒狀態，以及一項建議。 |
| `ccg usage` | 印出最新的用量快照。 |
| `ccg handoff` | 印出已啟用專案的交接 prompt。 |
| `ccg resume` | 發出 resume 指令（僅限 Claude Code；建議改用 `/ccgresume`）。 |
| `ccg config <path\|show>` | 顯示全域設定的路徑或內容。 |
| `ccg check-threshold [--five-hour N] [--seven-day N] [--json]` | 唯讀的門檻檢查，並提供可供腳本使用的離開碼。 |
| `ccg doctor` | 對 statusLine 接線、usage-state 新鮮度，以及此專案的 hooks 進行唯讀診斷。 |
| `ccg debug` | 傾印本機 guard／hook 狀態（僅含布林值與時間戳記）。 |

### Install threshold

首次執行時，`ccg install` 會設定 5 小時警告門檻。互動式終端機會提示輸入（預設為 `90`）；非互動式 shell 與 CI 則使用 `90`，或透過明確指定 `--five-hour-warning` 來決定：

```sh
ccg install --five-hour-warning 90
```

若想日後重新選擇門檻，可直接執行 `ccg install --reconfigure`，或是移除後重裝——`ccg uninstall` 現在本來就會連同全域設定一起還原掉，不需要額外的旗標：

```sh
ccg uninstall
ccg install
```

互動式終端機會再次提示輸入，預設值為目前的門檻；非互動式 shell 則需要明確指定 `--five-hour-warning`——若在非 TTY 環境單獨執行 `ccg install --reconfigure`，會報錯 `ccg install --reconfigure requires --five-hour-warning when stdin/stdout is not interactive`，而不會靜默把門檻重設為 `90`。（首次安裝不受影響：非互動式的首次執行仍會預設使用 `90`。）

### Uninstall flags

```sh
ccg uninstall                                    # fully restore to the pre-install state
ccg uninstall --remove                           # drop the guard statusLine instead of restoring the previous one
ccg uninstall --rmconfig                         # accepted but redundant — the config is already removed
ccg uninstall --restore-backup <path-to-backup>  # restore an exact backup instead
```

每一種形式都會先備份 `settings.json` 再動它，接著處理 statusLine——預設還原安裝前的那個、`--remove` 直接移除、`--restore-backup` 還原指定的備份檔——然後移除 `~/.claude/usage-state.json` 以及整個 `~/.claude/cache-guard/` 目錄（全域設定、install state、hook 狀態、log、備份）。這樣機器就回到 `ccg install` 執行之前的樣子。`~/.claude/next-session/` 底下的交接檔不會被動——那是專案內容，不是安裝留下的狀態。如果目前的 statusLine 不是 guard 的，就沒有什麼好還原的，`settings.json` 會原封不動、也不寫入備份。`--rmconfig` 單獨使用時已經不會改變任何行為，因為預設就會移除設定——保留這個旗標只是為了讓舊的腳本能繼續動。

### Settings reconciliation

變更門檻會立即協調目前的 hook episode。如果交接已在較低的門檻下觸發，而新門檻又高於目前的 5 小時用量，`ccg setting` 會立刻重置舊的觸發狀態——不必等到視窗重置；hook 即可在新門檻下再次觸發。如果目前用量仍等於或高於新門檻，則既有的觸發狀態維持為作用中。

### `ccg status` fields

`ccg status` 會顯示：專案是否已啟用、儲存的中繼資料是否仍符合目前路徑、專案 id、交接路徑、交接檔是否存在、是否啟用了自訂交接指引、5 小時／7 天用量、門檻狀態、交接模式（`auto` 或 `ask`）、hooks 是否已安裝、hook 提醒狀態，以及一項建議。hook 提醒狀態為下列其中之一：`not sent`、`waiting for main Claude handoff`、`handoff complete for this usage window; project quiet`（或在 ask 模式下為 `asked the user once this usage window; project quiet`）、`reset` 或 `disabled`；作用中的狀態還會顯示模式、首次觸發此 episode 的工作階段、觸發事件、提醒次數、更新時間、用量、處理時間，以及 hook 狀態的路徑。

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

`actions.on_warning` 控制用量達到警告門檻時的行為：

- `auto_handoff`（預設）：hook 會要求 Claude 立即寫入交接檔，並在檔案寫入後停止目前的目標，讓工作能在全新的工作階段中恢復。
- `ask`：hook 會詢問使用者要如何處理，且永遠不會自動停止。它是每次「越過門檻」詢問一次，而不是每個視窗只問一次——一旦用量回落到門檻之下、之後又再次越過門檻，就可能再次詢問。

`actions.usage_max_age_seconds`（選用）設定用量新鮮度視窗（秒）：若 `usage-state.json` 的 `updated_at` 早於此值，hook 會將讀數視為過期而不做任何事。預設為 `900`（15 分鐘），`ccg install` 不會寫入它——需手動加入以覆寫。

舊有的值 `suggest_handoff` 仍然可接受，行為與 `auto_handoff` 相同。`ccg install` 只在此檔案不存在時建立它，永遠不會覆寫既有的設定。

### Project config

`ccg enable` 會在專案根目錄寫入 `.claude-cache-guard.json`：

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

各專案的覆寫值放在 `overrides` 之下：

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

`~/.claude/usage-state.json` 透過白名單限制，只包含以下這些欄位——永遠不會儲存任何 token、認證、transcript、prompt 或工具輸入：

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

專案的 hook 狀態（位於 `~/.claude/cache-guard/hook-state/` 之下）另外會記錄首次觸發提醒的 Claude Code `session_id`，用於診斷，並在用量持續超過門檻期間進行專案層級的重複抑制。

## The handoff

交接檔存放在專案 repo 之外：

```text
~/.claude/next-session/<project-id>/next_session.md
```

`<project-id>` 的形式為 `<sanitized-project-name>--<8-char-path-hash>`。名稱來自工作目錄的 basename；雜湊則來自正規化後的絕對路徑，因此位於不同資料夾、同名的專案會得到不同的 id，且目錄名稱永遠不會包含完整路徑。`ccg enable` 會在目錄與起始的 `next_session.md` 不存在時建立它們，且除非加上 `--force`（這會先備份舊檔），否則永遠不會覆寫既有的檔案。

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

Current Status 裡的起始標記 `Initialized by claude-cache-guard.` 是 hook 用來判斷「這份起始範本是否已經被真正的交接內容取代」的依據：只要這段文字還在，hook 就會認定這個用量視窗的交接尚未寫入。

`ccg handoff` 會印出一份結構化的 prompt，包含明確的章節：角色、目標檔案、專案脈絡、流程、安全規則、輸出契約，以及品質標準。它要求 Claude 只讀取目前工作所需的脈絡，並寫出一份精簡的、用來取代原檔的 `next_session.md`；當舊的交接檔存在時，prompt 只把它當作來源素材，並覆寫整個檔案（絕不附加，也不就地修補）。

### Custom handoff guidance

`ccg enable` 會在專案裡建立 `.claude/ccg-handoff.md`——裡面只預先寫了一段說明用的 HTML 註解，沒有其他內容——旁邊還會附一份乾淨的 `.claude/ccg-handoff.md.bak`。編輯 `.claude/ccg-handoff.md`，在註解下方加上自己的提醒，一行一條，就能把專案專屬的指引附加到標準交接 prompt 之後；註解區塊本身不生效，所以只有註解的檔案算是未啟用。也可以直接跟 Claude 說你想加什麼提醒——起始註解裡就註明了 Claude 可以應你的要求編輯這個檔案。如果不小心把檔案改壞了，把 `.claude/ccg-handoff.md.bak` 複製回去蓋掉就能重新開始。

其內容是被附加的，永遠不會取代原本的內容：輸出契約、安全規則，以及逐字記錄的「Original User Prompts」永遠優先，因此自訂內容無法破壞 resume 或完成偵測。當此檔案生效時，`ccg status` 會顯示 `handoff guidance: active`；空白檔案（或只有註解的檔案）會被忽略。

## Hook behavior

- **Events：** Claude Code 的 `Stop` 與 `PostToolBatch`。`PostToolBatch` 涵蓋較長的 `/goal` 執行，其中 Claude 會在最終停止之前持續處理多批工具呼叫。
- **Trigger：** 目前專案的有效 5 小時用量達到警告門檻。
- **Scope：** 狀態以每專案、每 5 小時用量視窗為單位追蹤一次。某專案在一個視窗中被處理過一次後，無論目前是哪個工作階段在作用，該視窗內都會保持安靜。不同專案彼此獨立。
- **Window identity：** 視窗是以真實用量資料的 `five_hour.resets_at` 來識別，而非以實際時鐘時間。提早重置或新訂閱會改變 `resets_at`，並被視為一個可以再次警告的新視窗。已處理過的視窗，在用量回落到門檻之下時也會重新就緒（re-arm），可再次觸發提醒。
- **Freshness：** hook 只對新鮮的用量採取行動。如果 `usage-state.json` 的 `updated_at` 比新鮮度視窗（預設 15 分鐘）還舊，hook 就什麼都不做，因此一個過時的高百分比，無法在用量可能已經重置之後才觸發。
- **Main-agent only：** 含有 `agent_id` 的 hook 呼叫是子 agent 呼叫，會被忽略——子 agent 無法認領提醒，也無法覆寫專案的交接檔。
- **Stale guard：** 如果 `five_hour.resets_at` 已經過去，儲存的百分比會被視為過時，hook 會等待重新整理。
- **Auto mode：** 主 Claude agent 會收到 `ccg handoff` prompt，並被要求直接在確切的目標路徑上使用 `Write` 工具，以完整取代交接檔；一旦寫入完成，hook 就會停止目標。
- **Ask mode：** hook 會詢問使用者要如何處理，且永遠不會自動停止。它是每次「越過門檻」詢問一次：詢問過後，只要用量在該視窗內仍維持在門檻之上，就會保持安靜；如果用量回落到門檻之下、之後又再次越過門檻，就可能再次詢問。

hook 永遠不會直接呼叫 Claude，也不會寫入 `next_session.md`、push、publish 或 deploy。在 auto 模式下，它會注入指令、檢查磁碟上的檔案是否完成，然後停止目標；在 ask 模式下，它則把選擇呈現出來。

## check-threshold

`ccg check-threshold` 是供腳本使用的唯讀檢查器。它讀取 `~/.claude/usage-state.json` 與有效設定（全域 + 專案覆寫），而且不會讀取 stdin、不掃描無關的 `~/.claude` 檔案、不安裝 hooks、不變更設定，也不建立 `next_session.md`。

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

5 小時門檻來自有效設定（先取專案覆寫，否則取全域，否則取預設值 `90`）；`--five-hour` 會就單次執行覆寫它。`--seven-day` 會回報在 JSON 中以供未來自動化使用，但不影響離開碼——5 小時視窗才是作用中的閘門。

JSON output：

```json
{
  "status": "warning",
  "five_hour": { "used_percentage": 91, "threshold": 90 },
  "seven_day": { "used_percentage": 22, "threshold": null },
  "message": "You should update next_session.md soon."
}
```

## How it works

Claude Code 的 statusLine 命令會從 stdin 接收一個 JSON 物件，並把要呈現的那一行印到 stdout。安裝進 `~/.claude/settings.json` 的命令是：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/path/to/claude-cache-guard/bin/claude-cache-guard.js\" statusline",
    "padding": 0
  }
}
```

每次 statusLine 重新整理時，guard 會：

1. 從 stdin 讀取 Claude Code statusLine 的 JSON。
2. 只擷取白名單內的用量欄位。
3. 以「先寫入暫存檔再改名」的原子寫入方式寫入 `~/.claude/usage-state.json`。
4. 若先前的 statusLine 命令有被保留，則以相同的 JSON 輸入執行它。
5. 退而採用一個精簡的預設顯示：

```text
Opus 4.6 | ctx 42% | 5h 75% reset 2026-06-13T17:00:00Z | 7d 31% reset 2026-06-18T09:00:00Z
```

如果缺少 `rate_limits`，guard 不會崩潰：

```text
Opus 4.6 | ctx 42% | 5h n/a | 7d n/a | rate_limits unavailable
```

## References

- [Claude Code statusLine docs](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching and compaction docs](https://docs.claude.com/en/docs/claude-code/prompt-caching)
