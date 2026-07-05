# Claude Cache Guard

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)

`claude-cache-guard`（CLI：`ccg`）是一個純本機的 Claude Code 用量防護工具。它會在 5 小時用量視窗用盡前，讓 Claude 先把進度寫成一份精簡的交接檔（`next_session.md`），你就能在全新的小 session 接續工作——**不必把舊對話當成 uncached（未快取）token 重讀，也不像 `/clear` 那樣丟失細節**。

為什麼需要它：Claude Code 每回合都會重送整段對話，平常靠 prompt cache 吸收這筆成本；但在等一個用盡的視窗重置的期間，cache 早就失效了。這時恢復龐大的 session，**整段對話會被當成沒進過 cache 的輸入 token 重新讀一遍、全額算進你的用量，而且全發生在實際開始工作之前**——本來就有限的可用量，所剩無幾。

## 快速開始

### 第 1 步——安裝（每台機器一次）

```sh
npm install -g claude-cache-guard
ccg install
```

安裝過程只會問一個問題：

```text
At what 5-hour usage percentage should Claude start preparing next_session.md? [90]:
```

按 **Enter** 採用預設值（`90`），或輸入 `1` 到 `99` 之間的數字——之後隨時可以按專案調整。

> [!IMPORTANT]
> 裝完請**重新啟動 Claude Code——離開後重新執行 `claude`**（或在 app 裡開新 session），`/ccg*` slash command 才會載入，之後每個專案都能用。`/clear` **不夠**——它只清空對話，不會重新載入指令。

若不用 npm，改從原始碼安裝：

```sh
git clone https://github.com/yuliang615/claude-cache-guard.git && cd claude-cache-guard && ./scripts/install.sh
```

### 第 2 步——對專案啟用

在專案目錄啟動 `claude`，然後執行：

```text
/ccgenable
```

這樣就完成了——這個專案的交接工作流已經啟用。Claude Code v2.1.169 以上立即生效；較舊的版本要開一個新 session 才會完全生效（指令也會印出這則提示）。偏好終端機的話，在專案目錄跑 `ccg enable` 效果相同。它實際設定了哪些東西，見下方「運作原理」。

### 第 3 步——照常工作

當 5 小時用量到達門檻，ccg 會要求 Claude 寫一份精簡的 `next_session.md`，並結束目前任務——這一步你不用做任何事。門檻與警告行為可在下方「專案專屬設定」自訂。

### 第 4 步——接續工作

視窗重置後，開一個**新的** Claude Code session（或在原 session 先 `/clear`），執行：

```text
/ccgresume
```

Claude 會自動讀取交接檔並接手工作，不必重讀舊的工作階段。

> [!IMPORTANT]
> `/ccgresume` 請在全新的 session 執行。回到原本那個龐大的舊 session 繼續，整段對話又會被當成 uncached token 重讀一遍——交接省下的額度就白費了。

## 專案專屬設定（Per-project settings）

啟用專案之後，在 Claude Code 裡用 `/ccgconfig` slash command 為該專案自訂交接門檻與警告行為。不帶選項直接執行，會先顯示目前設定值，再跳出原生選單——5 小時門檻提供 **90 / 95 / 97 %** 三個選項（選「Other」可自填 1–99），加上警告模式——選完自動套用：

```text
/ccgconfig
```

要直接改、或想寫成腳本，就帶選項執行，會跳過選單直接套用。（終端機的 `ccg setting` 指令接受相同的選項；在 Claude Code 裡打 `! ccg setting ...` 則完全不經過模型、立即執行。）

### 門檻

預設門檻是 90%。若要為單一專案調低（或調高），不用選單、直接下指令：

```text
/ccgconfig --five-hour-warning 70
```

當 5 小時用量到達這個百分比，交接流程就會啟動。

### 警告模式（`--on-warning`）

`--on-warning` 控制用量到達門檻時的行為，有兩種模式：

`auto`（預設）— ccg 自動送出交接 prompt 給 Claude。Claude 寫完 `next_session.md` 後，ccg 會結束目前任務。整個過程不需要你手動操作，下一個工作階段直接從交接檔接續。

`ask` — ccg 會詢問你要寫交接並停止，還是繼續工作。它絕不會自動停止。它是每次「越過門檻」詢問一次，而不是每個視窗只問一次：詢問過後，只要用量維持在門檻之上就會保持安靜；如果用量回落到門檻之下、之後又再次越過門檻，就會再問一次。適合你還有剩餘額度、想當下自己決定的時候。

```text
/ccgconfig --on-warning ask    # 切換到 ask 模式
/ccgconfig --on-warning auto   # 切回 auto 模式
```

兩個選項可以在同一次指令中合併使用：

```text
/ccgconfig --five-hour-warning 70 --on-warning ask
```

覆寫值存在專案的 `.claude-cache-guard.json` 裡，立即生效。

### 自訂交接 prompt（進階，用不到可跳過）

先說這功能是幹嘛的：用量快到門檻時，CCG 會請 Claude 把「做到哪、接下來要做什麼」寫進交接檔 `next_session.md`。如果你希望 Claude 每次寫交接檔時多注意幾件你在意的事——例如交接前一定要跑一次測試——就把提醒寫進專案裡的 `.claude/ccg-handoff.md`，之後每次交接都會自動帶上。

最簡單的做法是**直接用說的**：告訴 Claude 你希望交接時多注意什麼，它就會幫你把提醒寫進 `.claude/ccg-handoff.md`——檔案裡本身就註明了 Claude 可以應你的要求編輯它。想自己動手也可以：`ccg enable` 已經幫你建好 `.claude/ccg-handoff.md` 了，檔案最上面有一段說明用的註解，那段註解會被忽略、不算提醒。在註解下面加你自己的提醒，一行寫一條就好。

如果不小心把檔案改壞了，旁邊留了一份乾淨的備份 `.claude/ccg-handoff.md.bak`，複製回去蓋掉就重新開始。

怎麼確認生效：跑 `/ccgstatus`，看到 `handoff guidance: active` 就是生效了；空白檔（或只剩註解的檔案）會被忽略。你的提醒只會「附加」在 CCG 標準交接指示的後面，不會取代它，所以不管寫什麼都不會弄壞恢復流程。

## Slash commands

`ccg install` 會把一組 slash command 裝進 `~/.claude/commands/`，每個專案都能用——名稱一律是 `ccg` + 對應的 CLI 子指令，中間不帶連字號。唯讀指令會在指令展開時預先執行對應的 ccg 指令，再交給輕量模型回報，所以回應快、幾乎不消耗 token：

| 指令 | 功能 |
|---|---|
| `/ccgresume` | 在新的工作階段從交接檔接續工作 |
| `/ccgstatus` | 顯示專案狀態，包含門檻檢查 |
| `/ccgusage` | 顯示目前用量 |
| `/ccgdisable` | 停用這個專案的 ccg |
| `/ccghandoff` | 印出交接 prompt |
| `/ccgdebug` | 執行診斷並顯示除錯資訊（會跑 `ccg doctor` 和 `ccg debug`） |
| `/ccgenable` | 啟用（或重新啟用）這個專案的 ccg |
| `/ccgconfig` | 調整專案設定——不帶選項會跳出選單用選的；帶選項（如 `--five-hour-warning 70`）直接套用 |

完整指令與選項見 [參考文件](docs/REFERENCE.zh-TW.md#commands)。

## 設定

全域預設值放在 `~/.claude/cache-guard/config.json`；每個專案的覆寫放在該專案的 `.claude-cache-guard.json`。優先順序是：內建預設 < 全域設定 < 專案覆寫 < CLI 選項。

想看一個專案目前生效的設定——5 小時門檻、它從哪裡來、以及目前的警告模式——執行 `/ccgstatus`。要調整就用 `/ccgconfig`，見上方「專案專屬設定」。（終端機對應指令：`ccg status`、`ccg setting`；`ccg config show` 可印出全域設定的原始 JSON。）完整設定結構與合併規則見 [參考文件](docs/REFERENCE.zh-TW.md#configuration)。

## 它儲存什麼

本工具只寫一個白名單檔案 `~/.claude/usage-state.json`，只保留 `source`、`updated_at`、`model`、`context_window`、`five_hour`、`seven_day` 這幾個欄位。絕不儲存任何 token、認證、對話記錄、prompt 或工具輸入，也不會有任何東西離開你的機器。完整結構見 [參考文件](docs/REFERENCE.zh-TW.md#data-stored)。

## 用量

在 Claude Code 裡執行 `/ccgusage`（或終端機的 `ccg usage`）：

```text
updated: 2026-06-13T12:00:00.000Z
model:   Opus 4.6
context: 42%
5h:      75% reset 2026-06-13T17:00:00Z
7d:      31% reset 2026-06-18T09:00:00Z
```

若 Claude Code 沒有提供可用的 `rate_limits`，`usage` 與 `doctor` 會如實說明，且不會在 `usage-state.json` 加上額外欄位。

## 疑難排解（Troubleshooting）

當有東西看起來不對勁時，在 Claude Code 裡執行 `/ccgdebug`——它會跑完兩項唯讀診斷，並解釋找到的問題。（終端機對應指令：`ccg doctor`、`ccg debug`。）

輸出只有狀態與時間戳記，不包含 statusLine 指令內容、設定值或憑證。診斷會標出常見的設定問題：`statusLine` 是否指向本工具、`~/.claude/usage-state.json` 是否在更新、已啟用專案的 hook 是否安裝、以及是否有 hook 錯誤被記錄。完整指令清單請跑 `ccg help`。

## 解除安裝（Uninstall）

```sh
ccg uninstall
```

`ccg uninstall` 會把電腦還原成安裝前的樣子：statusLine 還原、全域設定和用量狀態清掉、全域 slash 指令移除（你自己寫的同名檔案不會動）。交接檔會留著（在 `~/.claude/next-session/`），畢竟那是你的工作紀錄。

`--remove` 只移除 statusLine、不還原舊的；`--restore-backup <path>` 還原指定的備份。`--rmconfig` 還是接受，但已經不需要了——預設就會清掉全域設定；這兩個選項見 [參考文件](docs/REFERENCE.zh-TW.md#uninstall-flags)。

## 運作原理

`ccg install` 對全域只改一件事：備份 `~/.claude/settings.json`、只修補其中的 `statusLine` 欄位，並把 `/ccg*` slash command 複製到 `~/.claude/commands/`。（狀態列本身在下一次刷新就會生效——安裝後要重啟，是為了載入 slash command。）`ccg enable` 則嚴格限定在專案本地：在 `.claude/settings.local.json` 安裝 `Stop` 與 `PostToolBatch` hook、寫入專案設定，並建立起始的 `next_session.md` 與 `.claude/ccg-handoff.md` 提醒檔（見上方「自訂交接 prompt」）。

每次 statusLine 刷新時，本工具會從 stdin 讀取 Claude Code 的 JSON、只抽取白名單用量欄位、用「暫存檔再改名」的原子寫入方式寫到 `~/.claude/usage-state.json`，然後渲染你原本的狀態列（或一個精簡的預設顯示）。專案 hook 會讀這個檔案，並在 5 小時用量跨過門檻時觸發交接。statusLine 接線與完整 hook 行為見 [參考文件](docs/REFERENCE.zh-TW.md#how-it-works)；非互動式安裝（門檻預設 `90`，可用 `--five-hour-warning` 覆寫）等 install 選項見 [指令一覽](docs/REFERENCE.zh-TW.md#commands)。

## 參考資料

- 📖 **完整參考：** [`docs/REFERENCE.zh-TW.md`](docs/REFERENCE.zh-TW.md) — 每個指令與選項、設定與資料結構、交接格式，以及完整的 hook 行為。執行 `ccg help` 即可看到完整的指令與旗標一覽。
- [Claude Code statusLine 文件](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code 設定文件](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching 與 compaction 文件](https://docs.claude.com/en/docs/claude-code/prompt-caching)（compaction 會重用已快取的前綴）
