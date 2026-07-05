# Claude Cache Guard — Reference

Detailed reference for `claude-cache-guard` (CLI: `ccg`). The [README](../README.md) covers install and everyday use; this document holds the full command, configuration, data, and behavior reference. Run `ccg help` for the full command and flag summary.

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
| `ccg install [--reconfigure] [--five-hour-warning N]` | Back up `~/.claude/settings.json`, patch only `statusLine`, create the global config if missing, and install the `/ccg*` slash commands into `~/.claude/commands/` (available in every project from the next Claude Code session — new `claude` process; `/clear` does not reload them). `--reconfigure` rewrites thresholds on an existing config. |
| `ccg uninstall [--remove] [--rmconfig] [--restore-backup <file>]` | Fully restore the pre-install state: resolve the statusLine (restore the previous one, drop it with `--remove`, or restore a specific backup with `--restore-backup`), remove `usage-state.json` and the whole `~/.claude/cache-guard/` directory, and remove the global `/ccg*` slash commands from `~/.claude/commands/` (any file you wrote yourself under the same name is left alone). Handoff files are kept. `--rmconfig` is accepted but redundant — the config is already removed by default. |
| `ccg enable [--force]` | Enable the current project: write `.claude-cache-guard.json`, the `Stop`+`PostToolBatch` hooks, a starter handoff, and `.claude/ccg-handoff.md` (plus a pristine `.claude/ccg-handoff.md.bak`). Also cleans up any leftover project-local `.claude/commands/ccg*.md` from older versions — slash commands are now installed globally by `ccg install`. Config and files take effect immediately; the hooks reload automatically on Claude Code v2.1.169+ (older versions need a new session). `--force` overwrites the handoff (after a timestamped `.bak`). |
| `ccg disable [--rmhandoff]` | Remove this project's config, hooks, and hook state (plus any leftover project-local `ccg*.md` slash commands from older versions). Keeps the handoff file unless `--rmhandoff`. |
| `ccg setting [--five-hour-warning N] [--on-warning auto\|ask]` | Set per-project overrides. Non-TTY requires at least one flag. |
| `ccg status` | Report project state, usage, threshold, hook reminder state, and a recommendation. |
| `ccg usage` | Print the latest usage snapshot. |
| `ccg handoff` | Print the handoff prompt for the enabled project. |
| `ccg resume` | Emit a resume directive (Claude Code only; prefer `/ccgresume`). |
| `ccg config <path\|show>` | Show the global config path or contents. |
| `ccg check-threshold [--five-hour N] [--seven-day N] [--json]` | Read-only threshold check with scriptable exit codes. |
| `ccg doctor` | Read-only diagnostics of the statusLine wiring, usage-state freshness, and this project's hooks. |
| `ccg debug` | Dump local guard/hook state (booleans and timestamps only). |

### Install threshold

On first run `ccg install` sets the 5-hour warning threshold. Interactive terminals prompt for it (default `90`); non-interactive shells and CI use `90` or an explicit `--five-hour-warning`:

```sh
ccg install --five-hour-warning 90
```

To choose the threshold again later, run `ccg install --reconfigure` directly, or uninstall and reinstall — `ccg uninstall` already removes the global config as part of its full restore, so no extra flag is needed:

```sh
ccg uninstall
ccg install
```

An interactive terminal prompts again, defaulting to the current threshold. A non-interactive shell requires an explicit `--five-hour-warning`; running `ccg install --reconfigure` alone in a non-TTY errors with `ccg install --reconfigure requires --five-hour-warning when stdin/stdout is not interactive` instead of silently resetting the threshold to `90`. (First-time installs are unaffected: a non-interactive first run still defaults to `90`.)

### Uninstall flags

```sh
ccg uninstall                                    # fully restore to the pre-install state
ccg uninstall --remove                           # drop the guard statusLine instead of restoring the previous one
ccg uninstall --rmconfig                         # accepted but redundant — the config is already removed
ccg uninstall --restore-backup <path-to-backup>  # restore an exact backup instead
```

Every form backs up `settings.json` before touching it, resolves the statusLine — restoring what was there before install by default, dropping it with `--remove`, or restoring a specific file with `--restore-backup` — and then removes `~/.claude/usage-state.json` and the whole `~/.claude/cache-guard/` directory (global config, install state, hook state, logs, and backups). That puts the machine back to how it was before `ccg install` ran. Handoff files under `~/.claude/next-session/` are left alone; they're project content, not install state. If the current statusLine is not the guard's, there's nothing to restore, and `settings.json` is left untouched with no backup. `--rmconfig` no longer changes anything on its own since the config is already removed by default — it's still accepted so existing scripts keep working.

### Settings reconciliation

Changing the threshold reconciles the current hook episode immediately. If a handoff already triggered at a lower threshold and the new threshold is above current 5-hour usage, `ccg setting` resets the old trigger state at once — no need to wait for the window to reset; the hook can fire again at the new threshold. If current usage is still at or above the new threshold, the existing trigger state stays active.

### `ccg status` fields

`ccg status` shows whether the project is enabled, whether saved metadata still matches the current path, the project id, handoff path, whether the handoff file exists, whether custom handoff guidance is active, 5-hour / 7-day usage, threshold status, handoff mode (`auto` or `ask`), whether the hooks are installed, hook reminder state, and a recommendation. Hook reminder state is one of `not sent`, `waiting for main Claude handoff`, `handoff complete for this usage window; project quiet` (or, in ask mode, `asked the user once this usage window; project quiet`), `reset`, or `disabled`; active states also show the mode, the session that first triggered the episode, trigger event, reminder count, update time, usage, when it was handled, and the hook-state path.

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

`actions.on_warning` controls behavior when usage reaches the warning threshold:

- `auto_handoff` (default): the hook tells Claude to write the handoff now and, once the file is written, stops the current goal so work resumes in a fresh session.
- `ask`: the hook asks the user how to proceed and never stops automatically. It asks once per threshold crossing, not once per window — once usage falls back below the threshold and crosses it again, it can ask again.

`actions.usage_max_age_seconds` (optional) sets the usage freshness window in seconds: if `usage-state.json`'s `updated_at` is older than this, the hook treats the reading as stale and does nothing. It defaults to `900` (15 minutes) and is not written by `ccg install` — add it by hand to override.

The legacy value `suggest_handoff` is still accepted and behaves like `auto_handoff`. `ccg install` creates this file only if missing and never overwrites an existing config.

### Project config

`ccg enable` writes `.claude-cache-guard.json` in the project root:

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

Per-project overrides live under `overrides`:

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

`~/.claude/usage-state.json` is allowlisted to exactly these fields — no tokens, auth, transcripts, prompts, or tool inputs are ever stored:

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

Project hook state (under `~/.claude/cache-guard/hook-state/`) additionally records the Claude Code `session_id` that first triggered a reminder, for diagnostics and project-level duplicate suppression while usage stays over the threshold.

## The handoff

Handoff files live outside the project repo:

```text
~/.claude/next-session/<project-id>/next_session.md
```

`<project-id>` is `<sanitized-project-name>--<8-char-path-hash>`. The name comes from the working-directory basename; the hash comes from the canonical absolute path, so same-named projects in different folders get distinct ids and the directory name never includes the full path. `ccg enable` creates the directory and a starter `next_session.md` if absent, and never overwrites an existing one unless `--force` is passed (which backs up the old file first).

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

The `Initialized by claude-cache-guard.` marker in Current Status is how the hook tells whether this starter template has already been replaced by a real handoff: while that text is present, the hook treats the handoff as not yet written for this usage window.

`ccg handoff` prints a structured prompt with explicit sections for role, target file, project context, process, safety rules, output contract, and quality bar. It asks Claude to read only the context needed for the current work and write a concise replacement `next_session.md`; when an old handoff exists, the prompt uses it only as source material and overwrites the whole file (never appends or patches in place).

### Custom handoff guidance

`ccg enable` creates `.claude/ccg-handoff.md` in the project — pre-filled with an instructional HTML comment and nothing else — plus a pristine `.claude/ccg-handoff.md.bak` right next to it. Edit `.claude/ccg-handoff.md` and add your own reminders below the comment, one per line, to append project-specific guidance to the standard handoff prompt; the comment block itself is inert, so a comment-only file counts as inactive. You can also just tell Claude what you want reminded — the starter comment instructs it to edit this file on your request. If you break the file, copy `.claude/ccg-handoff.md.bak` back over it to start clean.

The contents are appended, never substituted: the output contract, safety rules, and verbatim "Original User Prompts" record always take precedence, so a customization cannot break resume or completion detection. `ccg status` shows `handoff guidance: active` while the file is in effect; an empty file (or one with only the comment block) is ignored.

## Hook behavior

- **Events:** Claude Code `Stop` and `PostToolBatch`. `PostToolBatch` covers long `/goal` runs where Claude continues through tool batches before a final stop.
- **Trigger:** the current project's effective 5-hour usage reaches the warning threshold.
- **Scope:** state is tracked once per project, per 5-hour usage window. After a project is handled once in a window it stays quiet for that window regardless of which session is active. Different projects are independent.
- **Window identity:** the window is identified by the real usage data's `five_hour.resets_at`, not wall-clock time. An early reset or new subscription changes `resets_at` and is treated as a new window that can warn again. A handled window also re-arms once usage drops back below the threshold.
- **Freshness:** the hook only acts on fresh usage. If `usage-state.json`'s `updated_at` is older than the freshness window (default 15 minutes), the hook does nothing, so a stale high percentage cannot fire after usage may already have reset.
- **Main-agent only:** hook calls containing `agent_id` are subagent calls and are ignored — a subagent cannot claim the reminder or overwrite the project handoff.
- **Stale guard:** if `five_hour.resets_at` has already passed, the stored percentage is treated as stale and the hook waits for a refresh.
- **Auto mode:** the main Claude agent receives the `ccg handoff` prompt and is asked to use the `Write` tool directly on the exact target path to fully replace the handoff; once written, the hook stops the goal.
- **Ask mode:** the hook asks the user how to proceed and never stops automatically. It asks once per threshold crossing: after asking, it stays quiet while usage remains above the threshold in that window; if usage falls below the threshold and crosses it again, it may ask again.

The hook never calls Claude directly, writes `next_session.md`, pushes, publishes, or deploys. In auto mode it injects the instruction, checks the file on disk for completion, then stops the goal; in ask mode it surfaces the choice.

## check-threshold

`ccg check-threshold` is a read-only checker for scripting. It reads `~/.claude/usage-state.json` and the effective config (global + project overrides), and does not read stdin, scan unrelated `~/.claude` files, install hooks, change settings, or create `next_session.md`.

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

The five-hour threshold comes from the effective config (project override, else global, else default `90`); `--five-hour` overrides it for a single run. `--seven-day` is reported in JSON for future automation but does not affect the exit code — the 5-hour window is the active gate.

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

Claude Code statusLine commands receive a JSON object on stdin and print the line to render on stdout. The command installed into `~/.claude/settings.json` is:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/path/to/claude-cache-guard/bin/claude-cache-guard.js\" statusline",
    "padding": 0
  }
}
```

On each statusLine refresh, the guard:

1. Reads Claude Code statusLine JSON from stdin.
2. Extracts only the allowlisted usage fields.
3. Writes `~/.claude/usage-state.json` with an atomic temp-file-and-rename write.
4. Runs the previous statusLine command with the same JSON input, if one was preserved.
5. Falls back to a compact default display:

```text
Opus 4.6 | ctx 42% | 5h 75% reset 2026-06-13T17:00:00Z | 7d 31% reset 2026-06-18T09:00:00Z
```

If `rate_limits` is missing, the guard does not crash:

```text
Opus 4.6 | ctx 42% | 5h n/a | 7d n/a | rate_limits unavailable
```

## References

- [Claude Code statusLine docs](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching and compaction docs](https://docs.claude.com/en/docs/claude-code/prompt-caching)
