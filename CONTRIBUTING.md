# Contributing

Control Tower is small and deliberately zero-dependency, with no build step. Keep contributions in
that spirit.

## Before you start

No new npm dependencies, no bundler, no framework — plain `.mjs`/`.js`/`.css`/`.html`. If a change
seems to need a dependency, open an issue or discussion first.

**Windows only, for now.** Terminal launching goes through PowerShell and Windows Terminal, and
there's no macOS/Linux support. Don't submit `process.platform` branching cold — open an issue to
discuss it first.

## Running it locally

```
node server.mjs
```
or double-click `start.cmd` (Windows only).

## Running the tests

```
node test/run.mjs
```
or `npm test`. Pass a keyword to filter suites, e.g. `node test/run.mjs api`.

`test/api-guards.mjs` is the suite that must stay green — it guards every write path. The browser
suite (`test/ui.mjs`) needs Playwright installed locally to actually run (`npm install playwright`,
not part of this repo's dependencies); without it, it self-skips with a passing note.

## Code style

No linter is configured — match the existing files. Keep diffs small and focused, and comment only
the *why* (a non-obvious constraint or workaround), not the *what*.

## Adding a provider

An OpenAI-compatible one (Gemini, DeepSeek, anything speaking the same `chat/completions` shape)
is meant to be one file plus one registry entry — see [Providers](README.md#providers) in the
README for what that means in practice, and copy `server/providers/openai.mjs` as the template.
A local-CLI provider (a hypothetical Codex or Gemini CLI) is a different shape entirely and would
follow Claude's own code in `server.mjs` instead — open an issue first if that's what you're after.

## Reporting bugs / requesting features

Use the issue templates.

## Security

No dedicated security contact is configured yet — for anything sensitive, avoid filing a public
issue with exploit details until there's a private channel to reach the maintainer.

## Pull requests

Run `node test/run.mjs` before opening a PR. If your change touches terminal launching, describe
what you tested manually — CI always runs with `FLEET_DRY_RUN=1`, so it never actually exercises
that path.
