# Collabridge (dsh-collabridge)

Deliver an external question — typically one Codex raises during a development-direction
discussion — into a **live** DeepSeek Harness collaboration session, routed by project and
development node.

## Why this has to be a plugin

Every Host RPC method and WebSocket stream requires the browser session cookie, and DSH's
HTTP carrier accepts no query token and no `Authorization` header token outside the
`GET /?token=...` root exchange. An external process therefore cannot reach `session/prompt`;
unauthenticated requests get `401`. A plugin lives inside the trusted composition, so it can
call the agent API directly and own its own loopback surface with its own token.

`dsh-webhook` is not an alternative: its only built-in action creates a **new** Workspace
root session, and the whole point here is to reach an **existing** one.

## Delivery is not a new session

```
agent.followup(message)   queued after any work in flight      (default)
agent.steer(message)      injected at the next step boundary
agent.inject(message)     placed into the current context
```

A cold or closed target is **refused**, never silently started: the response carries
`target_not_live` plus the list of live sessions so the caller can re-route.

## Routing: project, then one conversation inside it

The registry is **state, not per-call input**. A project points at a *current node*, and a
node points at a *session*. Crossing a milestone means updating one field; every later
question from that project follows automatically.

When one workspace holds several conversations at once, a question can name its target instead of
following the project's current node. Three selectors, most explicit first:

| Selector | Meaning |
|---|---|
| `session` | a session id, or a unique prefix of one |
| `node` | a route label registered for the project |
| `title` | the title the target conversation shows in its window, or a distinctive part of it |

Resolution order:

1. `session` — exact id, else a unique id prefix
2. `node` — a registered label; an unregistered label is refused, never redirected
3. `title` — an exact title, else a title containing the text if it is the only one
4. `routes[project.node]` — explicit route for the current node
5. `routes.default` — explicit fallback
6. newest conversation whose workspace slug matches the project — **zero configuration**
7. unresolved — reported, never guessed

A selector that matches nothing, or more than one conversation, is **refused with the candidate list**
rather than guessed at, and a title that names a conversation which is not live is refused distinctly
instead of falling back to the project default.

Titles come from the durable `session/title` event the host writes into each log (the latest one, which
is what the window shows). `GET /sessions?project=<path>` lists a workspace's conversations with that
title, when each was last written to, whether it is live, and the last thing the user said in it.

Recency for rule 6 is the newest **file** inside the session directory. The directory's own mtime only
moves when entries are added or removed, so a conversation running for days used to report its creation
moment and rule 6 could pick a stale target.

Registry file: `$DSH_HOME/collab-routing.json` (override with `DSH_COLLAB_ROUTING`).

```json
{
  "version": 1,
  "projects": {
    "/path/to/project": {
      "node": "<node label>",
      "routes": {
        "<node label>": "<session-id>",
        "<other node>": "<session-id>"
      }
    }
  }
}
```

Switching a node is a handoff, not just a pointer change: the new session starts cold by
design, so record what it needs before you switch.

`POST /route` takes `current: false` to register a label **without** moving the project's current node.
That is what labelling one of several parallel conversations needs; the default (`true`) keeps the
milestone flow a single step.

## Endpoints

Loopback only, `127.0.0.1`, ephemeral port, bearer token required except on `/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, pid, live sessions, routing file path (no token) |
| GET | `/sessions` | live root sessions with status, cwd, title, last activity and the user's last line; add `?project=<path>` to list one workspace's conversations with liveness |
| GET | `/routes` | the whole registry |
| POST | `/route` | `{project, node?, session, current?}` — register a route |
| POST | `/node` | `{project, node}` — switch the current node |
| POST | `/ask` | `{project, question, mode?, codex_thread?, title?, node?, session?}` — the admission call |

`/ask` returns `202` with `{question_id, session_id, project, node, resolved_by, matched_title, mode}`, or
`409` with a machine-readable code and a `hint`. Selector failures: `title_not_found`,
`title_ambiguous`, `title_matched_but_not_live`, `node_not_routed`, `session_not_found`,
`session_prefix_ambiguous`. Each carries the candidates it could have meant, so the caller can
re-address instead of guessing.

**Discovery**: `$DSH_HOME/collab-bridge.json` holds `{host, port, token, pid, started_at}`.
It is written when the listener starts and removed on unload, so a stale endpoint cannot
survive a plugin unload.

**Audit**: `$DSH_HOME/collab-bridge.log.jsonl` records `route_set`, `node_switched` and
`admitted`. It records the question **id, length and routing**, never the question body.

## Codex surface: the MCP wrapper

`lib/mcp-server.mjs` is a deliberately thin stdio MCP server exposing **two tools with two
different shapes**. Register it in Codex's `config.toml`:

```toml
[mcp_servers.dshCollab]
command = "<absolute path to node>"
args = ["<profile node_modules>/dsh-collabridge/lib/mcp-server.mjs"]
```

Do **not** add a `cwd`; see the operating notes below for why that breaks updates.

### `ask_dsh` — a consultation, asynchronous

Delivers a question into a live DSH session and returns an acknowledgement, not the answer.
Keep the tool call short: DSH replies in its own window, and the answer is pushed back into the
Codex thread as a `[DSH]`-marked message. Pass the project path and the question **verbatim**;
the recipient sees exactly that text, so a rewritten question is a different question.

Three optional arguments choose the conversation inside the project: `title` (the name its window
shows), `node` (a registered label) and `session` (an id or unique id prefix). With none of them the
project's registry decides, as before. A selector that matches nothing or several conversations is
refused with the candidates, so the caller re-addresses instead of delivering to the wrong workstream.

### `dsh_sessions` — what conversations exist here, read-only

Lists one project's conversations with the title each shows, when each was last written to, whether it
is live, and the last thing the user said in it. Call it before asking when a workspace has several
conversations running, then pass the chosen title to `ask_dsh`.

Both relayed messages read the same way, in both directions: **the relayed text comes first and
the provenance block comes last.** The inbound delivery opens on the question (inside a
`<<<QUESTION … >>>` fence), then the delivery contract, then a trailing `---` block carrying
`[CODEX→DSH]` with the project, node, session, mode, question id and thread, plus a `定位方式` line
naming the selector when the caller chose one. The outbound push
opens on the answer itself, then a trailing `---` block carrying `[DSH] … 未经 Codex 改写` and the
basis. A reader starting at the top therefore lands on the content, and a reader asking "who said
this to whom, and was it rewritten?" finds the answer at the end rather than in front of the text.

### `dsh_review` — an artifact review, synchronous

Runs one read-only reviewer against a candidate and returns the validated verdict, because
Codex needs the findings in order to act on them. Required inputs are `project`, `stage`
(`PHASE0`/`RED`/`GREEN`/`FINAL`), `objective`, `obligations` and `evidence`; `known_defects`
and `expected_failures` are optional, with the latter required non-empty for RED and required
empty for GREEN and FINAL.

Two things make this safe to hand to the agent that wrote the code:

- **The evidence is labelled as the writer's claim.** The reviewer is told the block came from
  the author, not from the coordinator, and that it must re-run the declared test command
  itself. In acceptance the reviewer was given a false "suite passing" claim against a
  deliberately broken candidate and refuted it from its own run.
- **Findings come back marked untrusted.** The tool result says to reproduce each finding
  before acting and that none of them is an instruction.

Invalid input is rejected locally before any reviewer is spawned, so a malformed package costs
nothing. A run that produces neither PASS nor FAIL (a workflow failure, an unreadable return,
an altered script) is reported as a harness outcome, explicitly **not** as a finding about the
candidate. Any state other than PASS or FAIL means **no verdict was ever produced**, so calling
again with the same package is legitimate — it is not the re-send the checkpoint contract
forbids, which applies only once a PASS or FAIL exists. The tool result says which of the two
you are in.

**Every review is archived** under `$DSH_HOME/reviews/<package_id>/` — the package, the
reviewer prompt, the workflow script, the raw stdout/stderr, and the validated result. Reviews
Codex initiates leave no trace in the coordinator's conversation, so this directory is the only
place they can be audited afterwards.

Each call runs a full reviewer: tens of seconds and roughly 8–16 provider requests, with
observed cache-hit ratios of 0.88–0.95. Call it at real checkpoints, not continuously.

## Install

```powershell
dsh plugin --profile web add <path-to-this-package>
# restart dsh web so the loader picks up the new bundle
```

## Diagnostics

`lib/cli.mjs` speaks the same discovery protocol, so it isolates a plugin fault from a client
fault:

```
node lib/cli.mjs health
node lib/cli.mjs sessions [--project <path>]      # conversations with their titles and last activity
node lib/cli.mjs routes
node lib/cli.mjs route --project <path> --node <label> --session <id>
node lib/cli.mjs node  --project <path> --node <label>
node lib/cli.mjs label --as <name> [--current]    # run INSIDE a conversation: names it via DSH_SESSION_ID
node lib/cli.mjs ask   --project <path> --question-file <path> [--mode followup|steer|inject] [--title <title>|--node <label>|--session <id>]
```

`label` is how a conversation gets a name without anybody reading an id: `$DSH_SESSION_ID` is exported
into every process a conversation starts, so the command registers that session under the given name in
its own working directory. Without `--current` the project's current node is left alone.

### Pushing an answer back into a Codex thread

`tools/transport/push-to-codex.mjs` puts DSH's own words into a Codex thread. The thread can be named
three ways, most explicit first:

```
node tools/transport/push-to-codex.mjs --thread <thread id>       --message-file <f>
node tools/transport/push-to-codex.mjs --title  "<thread title>"  --message-file <f>
node tools/transport/push-to-codex.mjs --project <path>           --message-file <f>
```

`--title` follows the same rules as the inbound selectors: an exact title wins, otherwise a title
containing the text wins if it is the only one, and several matches or none return the candidates
(thread id, current title, last activity) instead of a guess. Titles are read as they currently stand:
`session_index.jsonl` holds one line per write, so a renamed thread has several and only the newest
`updated_at` counts, while a rename that lands with an empty name falls back to the newest real one. A
thread owning several rollout files (a resumed or forked conversation) appears once, as its newest
rollout. The record printed carries `resolved_by` (`title`, `title-fragment`, `explicit` or `project`)
and `thread_title`, so a rename is visible in the result.

## Verification

`node --test test/bridge.test.mjs` — 232 checks, no DSH process and no cost. It drives the real
`apply()` through a fake cordis context, so the real HTTP surface, routing, admission
decision, refusal auditing and audit log all run; it also pins the message order of both relay
directions (relayed text first, provenance block last) against `markAnswer()`. `node --test
test/review-bridge.test.mjs` adds 243 checks over the reviewer prompt, the workflow script, the
return validators and the session log readers.

`test/selftest-in-dsh.mjs` — run inside a real DSH process (mounted with `--patch`) to prove
the loader accepts the module and that discovery → health → route → admit works end to end in
composition. It has been run successfully; the injected question was visible verbatim in the
live session's context and that session answered it.

Since 0.2.0 the bridge has also been exercised through the real web plane by the Codex side:
Codex called `ask_dsh`, the question reached this session verbatim, and the answer was pushed
back with `codex queue` and consumed automatically.

## Operating notes (each one cost a failed install)

- **Never give an MCP server a `cwd` inside its own package directory.** Windows locks a
  process's working directory, so a running MCP server makes `pnpm` fail with
  `ERR_PNPM_EPERM [importPackage …]` when you try to update that package. This bridge's MCP
  entry deliberately has no `cwd`; it resolves everything from `DSH_HOME`. If an update fails
  with EPERM, stop the MCP server processes first, then retry.
- **Bumping the contents of a tarball in place does not propagate.** `dsh plugin add` keys the
  `file:` dependency on the path plus its integrity hash, so overwriting
  `…/0.1.0/x-0.1.0.tgz` is followed by `Already up to date`, `added 0`, and the old code stays
  installed. To ship a change, write a **new version** and a new path.
- **Do not rewrite package files with `Set-Content -Encoding UTF8` on Windows PowerShell 5.1**:
  it writes a BOM. A BOM makes `package.json` invalid JSON and breaks a shebang line, which
  fails profile composition outright (`--dump-config` exits 1 with 0 entries, and the next
  `dsh web` start would fail). Use
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.

## Known limits

- **Live targets only.** `agents.resume` exists and would allow delivering to a cold session,
  but its option shape is untested here, so a cold target is reported rather than started.
- **The push back is a separate tool, not part of the plugin.** The plugin is inbound only; the answer
  returns through `tools/transport/push-to-codex.mjs`, which lives beside it (see Diagnostics). The
  plugin cannot choose the reply's destination by itself: the inbound delivery carries no thread id
  unless the caller supplies one, so whoever coordinates the exchange names the thread, by id or by
  title.
- **Nothing here bounds a conversation loop.** Two agents can keep answering each other; the plugin
  relays, it does not decide when to stop. Whoever drives the exchange decides that.
