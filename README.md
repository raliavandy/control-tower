# Control Tower

One screen for every Claude Code session on this machine — what each one is doing,
which ones are stuck waiting on you, and a reply box for each.

(The `FLEET_*` environment variables keep their name — renaming those would break saved
settings for no gain.)

Double-click **start.cmd**. It serves <http://localhost:7457/> and opens your browser.
No dependencies, no install, and the server binds to 127.0.0.1 only — nothing leaves the machine,
with two opt-in exceptions: if you set up an API-key provider (OpenAI today), your own key talks
to its API when you start a chat with it — see [Providers](#providers) — and clicking **Check for
updates** in the settings menu (never automatic) asks GitHub what the latest release is.

**Windows only, for now.** Terminal launching goes through PowerShell and Windows Terminal — there's
no macOS/Linux support yet.

The server window opens **minimised** so it never sits on top of the dashboard — it stays in the
taskbar as *Control Tower*, and closing that window stops the server. Run `start.cmd` again while
it is already up and it just opens the page instead of starting a second one.

Prefer no window at all? **start-tray.cmd** runs the same server with a system tray icon instead —
right-click it for Open, View log or Quit. Only one of the two should be running at a time; either
one detects the other and just opens the page instead of starting a second server.

```
node server.mjs            # same thing, from a terminal
FLEET_PORT=7500 node server.mjs
FLEET_NO_OPEN=1 node server.mjs   # don't launch a browser
FLEET_LAN=1 node server.mjs       # reachable from your phone - see "From your phone"
FLEET_KEY=MYCODE12 ...            # fixed phone access code instead of a fresh one
FLEET_DRY_RUN=1 ...               # Send writes the files but launches no terminal
```

**There is a manual.** The **?** button in the top bar (or pressing `?`) opens
<http://localhost:7457/help.html> — every view, every shortcut, every status, every environment
variable, every endpoint, and the things it deliberately cannot do. It is served by the app, so it
cannot drift from the build you are running, and a test asserts its contents links all resolve.

Five views along the top: **Sessions**, **MCP**, **Skills**, **Rules**, and **Usage** — that last
one is the sparkline pill itself, which doubles as its own tab rather than sitting beside a
duplicate button.

## Sessions

Each card is one session, newest activity first, with the ones needing you pinned to the top:

| | |
|---|---|
| **working** | a tool call is in flight, or Claude is mid-turn |
| **waiting for you** | Claude handed back **within the last 10 minutes** — you are probably still in the loop |
| **needs you** | a *quick* tool call has been pending too long, so probably a permission prompt |
| **still running** | a long `Bash`, subagent or MCP call. Not waiting on you, and out of the queue |
| **done** | finished its turn longer ago than that, nothing pending. Out of the attention queue |
| **idle** | alive but untouched for 2h+ |
| **ended** | no live process; resumable from history |

Plus: project, **where the chat started**, git branch, model, effort, permission mode, queued
messages, running subagents, prompt/turn counts, context size on the last request, MCP servers and
skills the session reached for, pid, and the last thing you asked.

### Where a chat came from

Claude Code stamps every transcript row with an entrypoint, so each card says where that session
began rather than leaving you to guess: **terminal**, **VS Code**, **Claude app**, **claude.ai**, or
**this page** for one started here headlessly. On this machine that reads 64 / 2 / 3 across VS Code,
the desktop app and the terminal. A session can start in one place and be continued in another — the
chip is where it *started*, and a separate *N turns here* chip counts what you have sent it from the
dashboard. `by where it started` is one of the grouping options.

The chrome is split by job. The **top bar** is where you are and what you do regardless of the
board: the view tabs, the usage sparkline, the headline, **+ New chat**, the text filter, **How to**,
and a **⋯** menu holding desktop alerts, light/dark and the phone pairing link. The **second row**
is only ever how the board is narrowed: your sections on the left, **Needs me / Live / All**, the
grouping and **bring back N dismissed** on the right.

### Expanding a card

The chevron next to a card's clock (or `e`, or a double-click) unfolds the last dozen messages
**inside the card** — who said what, the tool calls as chips — so you can see what a session is
doing without leaving the board. Capped at 320px with its own scroll, scrolled to the newest.

An open card refetches only when that session's `lastActivity` actually moves, so leaving several
expanded costs nothing while they are quiet (measured: zero requests over six seconds of ticks).
Which cards are open is remembered between visits.

### Reading a transcript

Click a card's **transcript** to read the conversation in a slide-over. Above it:

- **everything / your questions / Claude** — filter by who spoke. *Your questions* strips out
  every tool result and subagent turn, leaving a clean list of what you actually asked.
- **find in this chat** — text search over the loaded window, with matches highlighted.
- While a filter is on, each message grows a **show in context** link that drops the filter and
  scrolls to that message in the full log.
- **load more** pulls a larger slice when the session is longer than the window (it starts at the
  last 80 messages and grows to 400).

Images in a chat are shown inline. They live in the transcript as base64, so inlining them into
the conversation payload would mean multi-megabyte JSON — instead each keeps a reference and
`/api/image` decodes it on demand, addressed by (row uuid, block index) so the reference stays
valid however much the file grows. They load lazily; click one for full size.

### Counts always match the board

The numbers on **Needs me / Live / All** and in the headline are computed from what is actually on
screen, so they can't contradict it. Dismissing a card used to leave the header claiming a session
you couldn't see anywhere; now the headline says **· 1 dismissed** and a **bring back N dismissed**
link appears next to the filters.

### Changing model or effort

The **model** and **effort** chips on a card are clickable. Pick a value and it opens a new window
resuming that same chat with `--model` / `--effort` set — Claude Code cannot retune a session that
is already running, so this is the honest equivalent, exactly like the reply box. The window
already running that chat keeps whatever it started with. *another model…* takes any alias or full
name. Both values are whitelisted before they reach a command line.

A transcript cannot tell "Claude just handed back to you" apart from "Claude finished an hour ago
and you moved on" — both end with a completed assistant turn and silence. Calling both of them
*waiting for you* put long-finished chats in the attention queue demanding a reply, so the
hand-back decays into **done** after ten minutes (`FLEET_HANDBACK_MS` to change it).

It also cannot tell a permission prompt from a long-running command — both are a tool call with no
result yet. Two things separate them well enough to stop the false alarms:

- **What the tool is.** `Bash`, `PowerShell`, subagents, workflows and MCP calls legitimately run
  for minutes, so they get much longer patience (two minutes) and then report **still running**
  rather than *needs you*. Only after twelve quiet minutes (`FLEET_LONG_MS`) does one escalate.
- **Whether the session prompts at all.** Under `auto`, `acceptEdits`, `bypassPermissions`,
  `dontAsk` or `plan` there is no prompt to be waiting on, so a pending call is always work.

An amber **N queued** pill sits beside the status when a session has messages waiting in its own
queue — counted from the `queue-operation` rows, subtracting both dequeues *and* removes.

### Who to look at first

Every session that needs you gets a queue number. A stalled tool call outranks a finished
turn, and within each band the one that has been waiting longest wins — so **next up** is the
one to walk to. It is a quiet badge on the card and nothing else; `a` jumps straight to it.

Each card carries a pixel mascot whose mood is its status: eyes down and a `···` while it
works, a blinking `!` when it wants you, a fast twitchy `!` when it looks blocked, `z`s when
idle, lights-out when the process is gone. The browser tab icon is drawn from the same sprite
and takes the colour of the worst live status, so a red tab means someone is waiting.

Keys: `/` filter · `j`/`k` move · `Enter` transcript · `r` reply · `a` jump to #1 ·
`g` cycle grouping · `s`/`S` walk your sections · `1`–`5` switch view · `Ctrl+Enter` send · `Esc` close.

### Search

The **Search** tab reads every word of every transcript, not just the digested tail the board's
filter sees, and shows each match in context with the chat it came from. Two characters minimum.

### Your own sections

The row of tabs under the top bar is yours, and it works like browser tab groups: a section
holds **exactly the chats you put in it**, nothing else, ever. `by section` is one of the grouping
options, so the board can be laid out by the sections you defined.

Sections — and the theme, the collapsed groups, which cards are expanded, what you dismissed, the
chat stance — live in `prefs.json` next to the server, not in one browser's storage. Open the
dashboard on your phone and it is the same dashboard.

**+ section** makes an empty one. To fill it, use the **sections** link on any card — it opens a
little menu of your sections with a tick against the ones that chat is already in; click to add
or remove. The link itself reads back which sections a chat belongs to. Click a tab to narrow the
board to its members; your search text, filter and grouping are left alone. `s`/`S` walk the
tabs, double-click one to rename it, right-click to delete it (the chats are untouched).

Each tab shows how many chats are in it. Sections live in your browser's local storage.

## MCP

Every MCP server this machine knows about, grouped by where it comes from:

- **user scope** — `mcpServers` in `~/.claude.json`, offered in every project
- **from .mcp.json** — checked into a repo, with whether each project has actually enabled it
- **project-local** — configured for one project only
- **claude.ai connectors** — managed server-side; `mcp-needs-auth-cache.json` is the only
  on-disk trace, so ones that **need authorising** show up but healthy ones are only visible
  once a transcript proves they were used
- **available from plugins** — shipped by marketplace plugins, inactive unless installed
  (collapsed by default)

Each row shows its transport and real endpoint (an `npx mcp-remote https://…` wrapper is
unwrapped to the URL), env vars it needs, which projects enable it, and — from the transcripts
— how many calls it has taken and which sessions made them. Click a session chip to jump to it.

## Skills

Skills, subagents and slash commands, grouped by source: yours in `~/.claude`, per-project
`.claude/`, built into Claude Code, and everything the plugin marketplace offers. Descriptions
come from each file's frontmatter; click a name to copy it.

The bundled skills live inside the CLI rather than on disk, so only the ones you have actually
run can be listed — those come from the `skillUsage` counters in `~/.claude.json`, which also
supply the "run 3× · last 18 Jun" badges.

## Rules

Everything Claude already treats as standing instruction here, in one place:

- **memory** — `~/.claude/projects/<project>/memory/*.md`, grouped by project, with each fact's
  name, type and description
- **CLAUDE.md** — personal and per-project instruction files, deduplicated (your home folder is
  itself a "project" in `~/.claude.json`, so a naive scan finds every repo's file twice)
- **hooks** — commands the harness runs for you on its own, from every `settings.json`
- **permission rules** — everything you have already clicked "allow" on, per project, collapsed
  by default because one project has 88 of them

Click a name to copy it, **open** to load the file in VS Code, or **edit** to change it right here.

## Editing rules, skills and MCP servers

Every row that belongs to you has an **edit** link, each section a **+ new …**, and permission
rules an **×** each. Skills, agents, commands, memory and CLAUDE.md open in a plain text editor
(`Ctrl+Enter` saves). MCP servers open as a form — name, scope, transport, command/args/env or URL
— so a typo cannot corrupt anything.

These files decide how Claude behaves and what it may do without being asked, so the write path is
deliberately narrow:

- **The client never supplies a path to write.** It may only name a file the server already
  published in the inventory. Anything else — an absolute path, a `../` traversal — is refused.
- **Marketplace plugin copies are read-only.** An edit there is erased by the next plugin update,
  so it isn't offered.
- **New files get their path built server-side** from a validated name plus a known scope.
- **Every write and delete copies the original to `trash/` first.** Nothing is unrecoverable.
- **Writes are atomic** — temp file, re-read and re-parse it if it's JSON, then rename. `~/.claude.json`
  also holds your account and every project record, so a half-written one would be a bad day; only
  its `mcpServers` key is ever touched, and deleting that file outright is refused.
- Adding an **allow** rule means Claude stops asking about that thing, so it asks you to confirm.

A new or changed MCP server is picked up by the *next* Claude session, not a running one.

**Hooks** get a form too — when, an optional matcher, and the command — instead of hand-editing
`settings.json`. **history** on any editable file lists every earlier version from `trash/`, with
*view* and *restore*; restoring keeps the current contents as a version of their own. `trash/` is
capped (`FLEET_TRASH_KEEP`, 200 by default) so it cannot grow for ever.

An in-page chat can be **forgotten** from its card: it stops being pinned to the board and the
transcript is left alone.

## Usage

The pill in the top bar shows today's output tokens with a sparkline of the last fortnight, and
**is** the Usage tab — it takes the selected state like the others when you click it (or press
`5`). Inside: stat tiles for today / 7 days / 30 days / all time, output tokens per day with a
tooltip on every bar, and splits by model and by project.

Every block here minimises to its title row: click the title, or **minimise all** in the corner.
The state is remembered, so a block you shut stays shut next time (all five collapsed takes the
page from ~910px to ~306px).

**Where the numbers come from.** For Claude: `~/.claude/stats-cache.json` exists but only recomputes
when the CLI feels like it (on this machine it was months stale), so the figures are counted from
the transcripts instead — every assistant row carries a `usage` block. A full pass over ~100 MB
takes about half a second, and each file's entries are cached on (mtime, size), so only a live
session gets re-read. For OpenAI: every chat's own file already carries the real token counts the
API reported for each turn (see [Providers](#providers)). Both feed the *same* day/model/project
totals — the charts and rankings don't care which provider a given bar came from.

Two things that would otherwise make the totals wrong:

- Forked and resumed sessions **replay earlier messages** into new files — 6,400 of 11,500 rows
  here. Entries are keyed by API message id and counted once; the view tells you how many it skipped.
- "Last 30 days" means 30 **calendar** days, with quiet days filled as zero, not the last 30 days
  that happen to have data.

**Cost** is exact where it's on disk and zero otherwise — on a Claude subscription that's every
request (2,784 assistant rows scanned, no cost field anywhere, `stats-cache.json` reports
`costUSD: 0` for every model), so nothing prints until there's a real figure to show, rather than a
row of `$0.00`. OpenAI is different: it's genuinely metered, so once you've used it the view shows a
**real, if estimated**, dollar figure — computed from the actual token counts against a published
per-model price list kept in `server/providers/openai.mjs`, not a live lookup, so it can drift from
OpenAI's current pricing page.

**Your rate-limit window** shows at the top of the view — window type, whether you are still
allowed, when it resets, and whether extra usage is available. It is not on disk anywhere: the API
returns it on every turn, so it appears once you have sent one message from the in-page chat, and
goes stale from there. Run `/usage` inside Claude Code for Anthropic's own breakdown.

## Tray mode

**`start-tray.cmd`** runs the exact same server as `start.cmd`, just with no visible window at
all — a system tray icon takes its place. Right-click it (or double-click to open the dashboard):

| | |
|---|---|
| **Open Control Tower** | opens the dashboard in your browser |
| **View log** | the server's own stdout/stderr, since there's no console left to read it from — `%TEMP%\control-tower-tray.log` |
| **Quit** | stops the server and removes the icon |

It's the same detection as `start.cmd`: if the server is already up on the configured port,
running `start-tray.cmd` again just opens the page rather than starting a second one — and the
reverse holds too, so don't run both launchers for the same port at once.

Two things worth knowing about how it's built, since neither adds a dependency: getting a
`powershell.exe` script to run with genuinely no window (not even a flash) uses the standard
`wscript`-running-a-tiny-`.vbs` trick, because `-WindowStyle Hidden` alone doesn't fully suppress
it. And the server process is assigned to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
so it can never be orphaned running invisibly — if the tray process ends for *any* reason (Quit,
a crash, ending it from Task Manager), Windows itself guarantees the server goes down with it, not
just the click-through Quit handler.

## From your phone

`start.cmd` stays loopback-only. **`start-phone.cmd`** binds the port to your local network and
prints an access code:

```
  on your phone ->  http://192.168.0.96:7457/?k=K7QM4RTX
  access code   ->  K7QM4RTX   (asked once per device)
```

Open that link on your phone and it is paired — the code is stored in a cookie, so you only do
it once per device. Reach it later by just the address. On the PC a phone icon appears in the top
bar that copies the pairing link for you. Anything without a valid code gets an unlock screen,
API calls get a 401, and eight wrong guesses locks that device out for ten minutes. Requests from
this machine never need the code.

Set `FLEET_KEY=SOMETHING` (there is a commented line in `start-phone.cmd`) to keep the same code
across restarts instead of generating a fresh one each time.

**Understand what you are opening.** This UI launches terminals on your PC — Send opens a real
`claude --resume`, and "open in VS Code" opens VS Code here. Anyone on that network with the code
can do those things. Use it on your own Wi-Fi, never port-forward it, and don't run it on café
or hotel networks. Plain HTTP, so the code crosses the LAN unencrypted.

The layout collapses to one column on a phone, with touch-sized controls, the keyboard hints
hidden and the top bar left unpinned so it scrolls out of the way.

## Sending screenshots

Paste or drag an image into any reply box — on a card or in the transcript drawer — and it
appears as a thumbnail you can remove with the `×`. Six per message, 8 MB each.

Claude Code has no flag for attaching an image to a resumed prompt, so the server writes each
one next to the prompt file and appends its path to your message, ending with a nudge to read
them. The resumed session opens them with the Read tool. Files are named by the server, never
from the pasted filename.

## Chatting in the page

**+ New chat** starts a conversation that happens right here — no terminal window. Pick a folder,
type, `Ctrl+Enter`. The answer streams in as it is generated, tool calls appear as chips, and when
the turn ends the panel reloads the canonical transcript from disk. Replying from a card's box
does the same thing, opening the panel so you can watch it.

Under the hood the server runs Claude headless and relays it:

```
claude -p "<your message>" --verbose --output-format stream-json --include-partial-messages \
  [--resume <id> | --session-id <new uuid>] [--model …] [--effort …]
```

A new chat gets a `--session-id` up front, so it lands on the board like any other session and the
next message resumes it. **Stop** kills the process.

**Several conversations can answer at once, and you can collapse any of them.** Runs live on the
server, which buffers their events and replays them to whoever subscribes next — so closing the
panel loses nothing. Each off-screen run gets a pill bottom-right with its question, live status,
*open* and *stop*. When one finishes you get an "Answer ready" toast, and a desktop notification if
you have those on. Refreshing mid-answer catches up the same way.

The replay buffer keeps the accumulated *text* rather than every token delta, so reopening a long
answer shows all of it — buffering the deltas meant anything past about two thousand tokens came
back starting from the middle.

**export** in the panel toolbar downloads the conversation as Markdown.

### Chats you had here keep their card

A headless turn leaves no terminal process behind, so on the usual rules the card would count as
*ended* and disappear behind the **Live** filter the second you closed the panel. Every chat run
from this page is therefore recorded in `chats.json` next to the server, and gets its own status:

| | |
|---|---|
| **in this page** | no terminal, but a live conversation — sits with the running sessions, not in history |

They are listed ahead of the history slice so they can never be the ones that fall off the end of
it, they carry a *N turns here* chip, and the headline counts them (`· 2 chats here`). Open one and
carry on where you left off; the record survives restarting the server.

### What it can touch — the real constraint

Print mode has **no way to ask you about a tool call** (there is no `--permission-prompt-tool` in
this CLI), so it has to be agreed before the turn starts. That is the `can` selector:

| | |
|---|---|
| **read only** (default) | `--allowedTools Read Grep Glob NotebookRead WebFetch WebSearch TodoWrite Skill` — nothing can be written, so nothing needs asking |
| **read + edit files** | `--permission-mode acceptEdits` — file edits go through without asking |
| **anything, no prompts** | `--permission-mode bypassPermissions` — every tool runs unasked. **Refused for anything but this machine**: a paired phone cannot select it |

**open in terminal** is still there for anything print mode can't do — the real interactive TUI,
where you get proper permission prompts. It runs `claude --resume <id>` (or a fresh `claude`) in
Windows Terminal, passing your message via a temp file so quotes, newlines and `%` are safe. Note
the window already running a live session keeps its own state, so that gives you a second window
on the same history.

`copy resume cmd` puts `claude --resume <id>` on your clipboard if you'd rather drive it yourself.

## Providers

Claude Code isn't hardcoded any more — it's the first entry in a small registry (`GET
/api/providers`), and OpenAI is the second. The two work very differently, and the board is honest
about that rather than pretending they're the same thing:

| | Claude Code | OpenAI (ChatGPT) |
|---|---|---|
| what it is | a local CLI with its own on-disk transcripts | an API key you provide |
| a session exists because | you (or this app) started `claude` | this app called the API and kept the reply |
| resume in a terminal | yes | no such thing — there's no terminal to reattach to |
| folder / permission stance | yes | no — nothing runs locally, so neither applies |
| watches sessions started elsewhere | yes (any `claude` process, any terminal) | no — this app is the only place an OpenAI chat can exist |

**Setting it up**: `⋯` menu → *OpenAI API key — set it up*. Get one at
platform.openai.com/api-keys — it's billed separately from any ChatGPT subscription, even on the
same account. The key is stored in plaintext in `provider-keys.json` next to the server — the same
trust model this app already uses for an MCP server's own `env` values (filesystem permissions and
the app's own token, not a vault), and it's `.gitignore`d. `GET /api/provider-keys` only ever
returns whether a key is set and its last 4 characters — never the key itself.

Pick **ChatGPT** from the assistant dropdown in **+ New chat** to start one. It streams into the
page exactly like a headless Claude turn, using Node's built-in `fetch` to call
`api.openai.com/v1/chat/completions` with `stream: true` — the one outbound network call this app
makes, and only when you've configured a key and started a chat. Each conversation is its own file
under `openai-chats/` (also `.gitignore`d), since Chat Completions has no memory of its own — the
full history is resent every turn.

**Forget** vs **Delete** matter more here than for Claude: Claude's transcript lives on its own
regardless of what this app does, so *forget* just unpins the card. An OpenAI chat's file *is* the
only copy, so *forget* only unpins it (it sinks into history, same as a Claude session that isn't
running), while **Delete** removes it for good.

**Adding another API-key provider** (Gemini, DeepSeek, or anything speaking the same
OpenAI-compatible `chat/completions` format — which covers most hosted models) is meant to be one
file plus one registry entry, not a search-and-replace across this codebase. Every route that
touches a chat — `/api/chat`, forget, delete, key test, deep search, usage — reads the
`API_PROVIDERS` table in `server.mjs` rather than naming a provider, so `server/providers/openai.mjs`
is the template to copy: same session shape, same `fleet_text`/`stream_event` event vocabulary, same
file-per-conversation storage. The frontend needs nothing extra either — capability flags
(`hasFolder`, `hasStance`, `models`, `efforts`, `hasImages`, `deletable`) already drive the UI
generically through `providerOf()`.

**Local-CLI agents** (a hypothetical Codex CLI, Gemini CLI accessed as a CLI rather than an API)
are a different shape entirely — no API key, a real local process, its own resumable session — and
would follow Claude's own pattern in `server.mjs` (`claudeSessions()`, `startChat()`, ...) rather
than the `API_PROVIDERS` registry. None of that is built yet: nothing like that was installed on
this machine to build and test against.

## Where the data comes from

Read-only, from your local Claude Code state:

- `~/.claude/sessions/*.json` — live processes (pid, cwd, entrypoint). A pid is checked with
  signal 0, so "live" means the process is really there.
- `~/.claude/projects/<slug>/<session-id>.jsonl` — the transcripts. Only the tail of each
  file is read (256 KB, or 3 MB when big pasted images swallow the tail), so it stays fast
  on multi-megabyte histories, and results are cached until the file changes.
- `~/.claude.json` — MCP server definitions, the list of projects, and skill usage counters.
  Note it genuinely contains both `c:/…` and `C:/…` keys for the same project; those get merged.
- `~/.claude/mcp-needs-auth-cache.json` — which servers are waiting to be authorised.
- `<project>/.mcp.json`, `<project>/.claude/settings*.json` — shared servers and whether the
  project enabled them.
- `~/.claude/skills`, `~/.claude/agents`, `~/.claude/commands`, the same folders under each
  project's `.claude/`, and `~/.claude/plugins/marketplaces/*/…/<plugin>/{skills,agents,commands}`.

Because call counts come from the same tail window as everything else, they describe recent
activity, not lifetime totals.

**Status is inferred, not reported.** Permission prompts and "Claude is idle" are never
written to the transcript, so *needs you* is derived from "a tool call has no result yet and
nothing has been written for a while". How long is "a while" depends on the tool, because a
stalled `Edit` and a stalled `Bash` mean different things — 12s for an edit/write, 25s for the
middle ground, 75s for `Bash`, subagents, workflows and MCP calls. A long `npm run build` can
still look like a permission prompt. Treat it as a strong hint, not a fact.

Only Claude Code sessions on this machine are visible here — claude.ai web chats and the
desktop app live server-side and aren't in `~/.claude`.

## Files

| | |
|---|---|
| `server.mjs` | scanner, inventory, JSON API, SSE, the headless chat runner, all the write paths, the `API_PROVIDERS` registry |
| `server/providers/openai.mjs` | the OpenAI provider: its own session store, read side, and chat streaming |
| `server/lib/util.mjs` | tiny helpers shared between `server.mjs` and every provider module |
| `start.cmd` · `start-tray.cmd` | double-click either to run it — a minimised console window, or a system tray icon |
| `tray.ps1` | the tray icon itself: runs the server hidden, backed by a Job Object so it can't be orphaned |
| `public/index.html` | markup + card and group templates |
| `public/app-*.js` | the front end, in load order — core, shots, cards, board, menus, inventory, usage, search, chat, drawer, chrome |
| `public/pixel.js` | the mascots: 12×12 string art → `<rect>`s, two-frame flipbooks, tab icon |
| `public/styles.css` | dark/light theming |
| `public/help.html` · `help.css` | the manual, served at `/help.html` |
| `provider-keys.json` | your OpenAI key, if you've set one up — plaintext, `.gitignore`d |
| `openai-chats/` | one file per OpenAI conversation — `.gitignore`d |
| `test/` | `node test/run.mjs` — see below |

The `app-*.js` files are plain classic scripts loaded in order, so they share one top-level scope
and need no bundler. Only immediately-running code is order-sensitive, and the boot block lives at
the end of `app-chrome.js`.

## Tests

```
node test/run.mjs            # everything
node test/run.mjs guards     # only suites matching "guards"
```

It starts its own server on port 7999 with `FLEET_DRY_RUN=1`, so nothing in the suite can open a
terminal, and points `FLEET_PREFS_FILE` at a scratch file so a test run never rearranges your real
dashboard. 106 checks: the write guards (every path the app must refuse), the response shapes the
front end assumes, and a browser pass over the board, the Enter/Ctrl+Enter rule, the counts, card
expansion, accessible names, focus trapping and deep search.

`test/api-guards.mjs` is the one to keep green. It asserts the refusals — paths outside the
inventory, traversals, marketplace copies, deleting `~/.claude.json`, invalid JSON, a name with a
traversal in it — and that a no-op save of a real MCP server leaves `~/.claude.json` byte-identical.
The browser suite is skipped with a note if Playwright isn't resolvable.

One gotcha if you touch the sprites: the sheet has a global `svg { fill: none; stroke: currentColor }`
for the icon set, and inherited CSS beats a `fill=""` attribute — so sprite pixels take their
colour from the `.px-body` / `.px-ink` classes, not from attributes.

| `start.cmd` | double-click to run it, loopback only |
| `start-phone.cmd` | same, but reachable from your phone with an access code |
| `start-tray.cmd` | same server, a tray icon instead of a console window — see [Tray mode](#tray-mode) |

POST actions require a per-run token that the server injects into the page, so a random website
can't drive your terminal through this port. That token belongs to one server run — restart the
server under an open tab and every write used to fail with *bad token* until you reloaded. The page
now notices, fetches the current token from `/api/token` and retries the same request. That endpoint
does not weaken anything: a cross-origin page may call it but the browser will not let it read the
response, which is exactly why the token works. In the default mode every request must also arrive
on a loopback Host header. With `FLEET_LAN=1` the port opens to the network and the access code
becomes the thing standing in the way — requests are judged by the socket's real address, not by
a Host header a client can invent.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Want to contribute? See [CONTRIBUTING.md](CONTRIBUTING.md).
