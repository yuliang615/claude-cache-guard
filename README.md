# Claude Cache Guard

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

`claude-cache-guard` (CLI: `ccg`) is a local-only usage guard for Claude Code. Before your 5-hour usage window runs out, it has Claude write a compact handoff file (`next_session.md`) so you pick the work back up in a fresh, small session — **no re-reading the old conversation as uncached tokens, no `/clear`-style loss of detail**.

Why: Claude Code re-sends the whole conversation every turn, and prompt caching normally absorbs that — but the cache goes cold while you wait out a spent window. Resume a big session then, and **the entire conversation is re-read as uncached input tokens, charged in full against your usage, before any real work starts** — and the window didn't hold much to begin with.

## Quick start

### Step 1 — Install (once per machine)

```sh
npm install -g claude-cache-guard
ccg install
```

The installer asks one question:

```text
At what 5-hour usage percentage should Claude start preparing next_session.md? [90]:
```

Press **Enter** to accept the default (`90`), or type a number from `1` to `99` — you can change it per project later.

> [!IMPORTANT]
> After installing, **restart Claude Code — exit and run `claude` again** (or open a new session in the app). That's what loads the `/ccg*` slash commands, which then work in every project. `/clear` is **not** enough: it clears the conversation but does not reload commands.

From source instead of npm:

```sh
git clone https://github.com/yuliang615/claude-cache-guard.git && cd claude-cache-guard && ./scripts/install.sh
```

### Step 2 — Enable for the project

In the project's directory, start `claude` and run:

```text
/ccgenable
```

That's it — the handoff workflow is now active for this project. On Claude Code v2.1.169+ it takes effect right away; on older versions, start a new session for it to fully kick in (the command prints a note about this). Prefer the terminal? `ccg enable` in the project directory does the same thing. What it actually sets up is covered in **How it works** below.

### Step 3 — Work as usual

When 5-hour usage reaches the threshold, ccg asks Claude to write a compact `next_session.md` and stops the goal — nothing for you to do here. Customize the threshold and warning behavior in **Per-project settings** below.

### Step 4 — Pick the work back up

After the window resets, open a **new** Claude Code session (or `/clear` the current one) and run:

```text
/ccgresume
```

Claude reads the handoff and picks the work back up automatically — no re-reading the old session.

> [!IMPORTANT]
> Run `/ccgresume` in a fresh session. Going back to the old, big session re-reads the whole conversation as uncached tokens — exactly the cost the handoff just saved you.

## Per-project settings

After enabling a project, customize its handoff threshold and warning behavior with the `/ccgconfig` slash command inside Claude Code. Run it with no arguments and it shows the current values, then pops up a native selection menu for both settings — 5-hour threshold choices of **90 / 95 / 97 %** ("Other" accepts any 1–99), and the warning mode. Pick, and they are applied for you:

```text
/ccgconfig
```

For a direct or scriptable change, pass flags instead and skip the menu. (The `ccg setting` terminal command takes the same flags; `! ccg setting ...` inside Claude Code runs it instantly with no model involvement.)

### Threshold

The default threshold is 90 %. To lower (or raise) it for a single project without the menu:

```text
/ccgconfig --five-hour-warning 70
```

When 5-hour usage reaches this percentage, the handoff kicks in.

### Warning mode (`--on-warning`)

`--on-warning` controls what happens when usage hits the threshold. There are two modes:

`auto` (the default) — ccg sends Claude the handoff prompt automatically. Claude writes `next_session.md`, and once the file is written ccg stops the current goal. No user interaction is needed; the next session picks up from the handoff file.

`ask` — ccg asks you whether to write the handoff and stop, or keep going. It never stops on its own. It asks once per threshold crossing, not once per window: once usage falls back below the threshold and crosses it again, it can ask again. This is useful when you still have budget left and want to decide in the moment.

```text
/ccgconfig --on-warning ask    # switch to ask mode
/ccgconfig --on-warning auto   # switch back to auto mode
```

Both options can be combined in one call:

```text
/ccgconfig --five-hour-warning 70 --on-warning ask
```

Overrides are stored in the project's `.claude-cache-guard.json` and take effect immediately.

### Custom handoff prompt (optional)

What this is for: when usage nears the threshold, CCG asks Claude to write down where things stand in the handoff file `next_session.md`. If there are things you want Claude to take care of every time it writes that handoff — say, always run the tests first — put those reminders in `.claude/ccg-handoff.md` inside the project. They ride along on every handoff from then on.

The easiest way is to **just say it**: tell Claude what you want watched at handoff time, and it edits `.claude/ccg-handoff.md` for you — the file itself tells Claude it may do that on your request. Prefer to do it by hand? `ccg enable` already created `.claude/ccg-handoff.md`, with a comment block at the top that explains itself and is ignored — it doesn't count as a reminder. Add your own lines below it, one reminder per line.

If you end up breaking the file, a clean copy is sitting right next to it at `.claude/ccg-handoff.md.bak` — copy it back over and you're starting fresh.

To check it took effect: run `/ccgstatus` and look for `handoff guidance: active`. An empty file (or one with just the comment block) is ignored. Your reminders are appended after CCG's standard handoff instructions — they never replace them — so nothing you write here can break the resume flow.

## Slash commands

`ccg install` puts a set of slash commands in `~/.claude/commands/`, available in every project — each named `ccg` + the CLI subcommand it wraps, with no hyphen. Read-only commands pre-run their ccg call the moment the command expands and hand the output to a lightweight model to format, so they respond fast and use almost no tokens:

| Command | What it does |
|---|---|
| `/ccgresume` | Continue from the handoff in a new session |
| `/ccgstatus` | Show project status, including the threshold check |
| `/ccgusage` | Show current usage |
| `/ccgdisable` | Disable ccg for this project |
| `/ccghandoff` | Print the handoff prompt |
| `/ccgdebug` | Run diagnostics and show debug info (runs `ccg doctor` and `ccg debug`) |
| `/ccgenable` | Enable or re-enable ccg for this project |
| `/ccgconfig` | Adjust project settings — no flags opens a selection menu; flags like `--five-hour-warning 70` apply directly |

See the [reference](docs/REFERENCE.md#commands) for every command and flag.

## Configuration

Global defaults live in `~/.claude/cache-guard/config.json`; per-project overrides live in each project's `.claude-cache-guard.json`. Priority is built-in defaults < global config < project overrides < CLI flags.

To see a project's effective settings — the 5-hour threshold, where it comes from, and the current warning mode — run `/ccgstatus`. To change them, use `/ccgconfig`, as covered in **Per-project settings** above. (Terminal equivalents: `ccg status` and `ccg setting`; `ccg config show` prints the raw global config JSON.) See the [reference](docs/REFERENCE.md#configuration) for the full config schema and merge rules.

## What it stores

The guard writes a single allowlisted file, `~/.claude/usage-state.json`, holding only `source`, `updated_at`, `model`, `context_window`, `five_hour`, and `seven_day`. No tokens, auth, transcripts, prompts, or tool inputs are ever stored, and nothing leaves your machine. See the [reference](docs/REFERENCE.md#data-stored) for the exact schema.

## Usage

Run `/ccgusage` in Claude Code (or `ccg usage` in a terminal):

```text
updated: 2026-06-13T12:00:00.000Z
model:   Opus 4.6
context: 42%
5h:      75% reset 2026-06-13T17:00:00Z
7d:      31% reset 2026-06-18T09:00:00Z
```

If Claude Code does not include usable `rate_limits`, `usage` and `doctor` say so without adding fields to `usage-state.json`.

## Troubleshooting

When something looks off, run `/ccgdebug` in Claude Code — it runs both read-only diagnostics and explains any problem it finds. (Terminal equivalents: `ccg doctor` and `ccg debug`.)

The output is just state and timestamps — no statusLine command text, config values, or credentials. The doctor check flags the common setup problems: whether `statusLine` points to this guard, whether `~/.claude/usage-state.json` is updating, whether the enabled project's hooks are installed, and whether any hook errors were recorded. Run `ccg help` for the full command list.

## Uninstall

```sh
ccg uninstall
```

`ccg uninstall` puts your machine back the way it was before `ccg install`: the statusLine gets restored, the global config and usage state get cleared out, and the global `/ccg*` slash commands are removed (any file you wrote yourself under the same name is left alone). Handoff files stay right where they are, under `~/.claude/next-session/`, since that's your work, not install state.

`--remove` drops the statusLine instead of restoring the previous one, and `--restore-backup <path>` restores an exact backup instead. `--rmconfig` is still accepted but no longer needed — the config is already gone by default. See the [reference](docs/REFERENCE.md#uninstall-flags) for both flags.

## How it works

`ccg install` changes exactly one global thing: it backs up `~/.claude/settings.json`, patches only its `statusLine` field, and copies the `/ccg*` slash commands into `~/.claude/commands/`. (The status line itself goes live on the next refresh — the post-install restart is what loads the slash commands.) `ccg enable` is strictly project-local: it installs the `Stop` and `PostToolBatch` hooks in `.claude/settings.local.json`, writes the project config, and creates a starter `next_session.md` plus the `.claude/ccg-handoff.md` reminder file (see **Custom handoff prompt** above).

On every statusLine refresh the guard reads Claude Code's JSON from stdin, extracts only the allowlisted usage fields, writes them atomically to `~/.claude/usage-state.json`, and then renders your previous status line (or a compact default). The project hooks read that file and trigger the handoff when 5-hour usage crosses the threshold. See the [reference](docs/REFERENCE.md#how-it-works) for the statusLine wiring and the full hook behavior, and [`ccg install`'s flags](docs/REFERENCE.md#commands) for non-interactive installs (they default the threshold to `90`; override with `--five-hour-warning`).

## References

- 📖 **Full reference:** [`docs/REFERENCE.md`](docs/REFERENCE.md) — every command and flag, the configuration and data schemas, the handoff format, and the complete hook behavior. Run `ccg help` for the full command and flag summary.
- [Claude Code statusLine docs](https://docs.anthropic.com/en/docs/claude-code/statusline)
- [Claude Code settings docs](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code prompt caching and compaction docs](https://docs.claude.com/en/docs/claude-code/prompt-caching) (compaction reuses the cached prefix)
