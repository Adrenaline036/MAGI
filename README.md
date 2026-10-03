# Collabridge

**Ask a live DeepSeek Harness session from Codex, and get a verdict you can cite.**

Collabridge is a [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin plus an MCP stdio
server. It gives a coding agent two abilities it does not otherwise have:

| Tool | What it does |
|---|---|
| `ask_dsh` | Delivers a question into a **live, already-running** DSH collaboration session and returns immediately. The session answers in its own time, in its own context, with the user's own project state in front of it. |
| `dsh_review` | Runs an **independent reviewer** against a candidate directory at a checkpoint (stage `PHASE0` / `FINAL` / `GREEN` / `RED`) and returns a verdict: findings, unknowns, and structural limits. The verdict is bound to an exact package id and nonce, so it cannot be replayed onto a different candidate. |

The point of `ask_dsh` is that the answer comes from a session that has been working in that project,
not from a fresh stateless call. The point of `dsh_review` is that the verdict is **not** produced by
the agent that wrote the code.

The four constraints that shaped the design, and why the plugin has the shape it has, are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Why this has to be a plugin

Every Host RPC method and WebSocket stream on the DSH HTTP carrier requires the browser session
cookie. The carrier accepts no query token and no `Authorization` header token outside the
`GET /?token=...` root exchange, so an external process cannot reach `session/prompt`;
unauthenticated requests get `401`.

A plugin lives inside the trusted composition instead. It owns a loopback endpoint, receives a
question from outside, and admits it into a live session as a real inbound message. That is the whole
reason Collabridge is shaped like a plugin rather than a client script.

## Install

Collabridge is a DSH bundle patch: it is installed into a profile's `node_modules` and listed in that
profile's bundle list.

1. Put the package where the profile can resolve it:
   ```
   dsh plugin --profile <profile> add file:<path-to>/dsh-collabridge-<version>.tgz
   ```
   If the profile is app-managed (the desktop profile refuses CLI management with
   `profile "<name>" is managed exclusively by the Electron application`), add the dependency and the
   bundle entry to the profile's `package.json` yourself, update its lock and
   `node_modules/.modules.yaml`, and unpack the tarball into `node_modules/dsh-collabridge`.
2. Restart DSH so the composition picks up the bundle.
3. Register the Codex side. Paste this into `~/.codex/config.toml` and restart Codex:

   ```toml
   [mcp_servers.dshCollab]
   command = '<path to node.exe>'
   tool_timeout_sec = 1800            # a review runs a full external reviewer
   args = ['<DSH_HOME>\profiles\<profile>\node_modules\dsh-collabridge\lib\mcp-server.mjs']

   [mcp_servers.dshCollab.tools.ask_dsh]
   approval_mode = "approve"

   [mcp_servers.dshCollab.env]
   DSH_HOME = '<DSH_HOME>'
   ```
   `tool_timeout_sec` matters: Codex's default call deadline is around 300 s and a review can take
   longer than that.
4. Route projects to sessions (see below).
5. Verify with `node --test test/bridge.test.mjs` and `node --test test/review-bridge.test.mjs`.

**Upgrading from the old name.** Releases before 0.6.0 were published as `dsh-collab-bridge`. A
profile that still lists that name must have its dependency, bundle entry and lock entries removed
first: two installed copies would both mount a host half and fight over the same loopback port.

## Routing: which DSH session gets the question

A question is addressed to a **project**, optionally at a **development node** (a milestone label such
as `phase0` or `bridge-maintain`). Resolution order:

1. `routes[project][node]`
2. `routes[project].default`
3. the newest live session whose workspace slug matches the project
4. unresolved, reported as such

A session id is a per-machine fact. Never copy one between machines.

```jsonc
// $DSH_HOME/collab-routing.json
{
  "version": 1,
  "projects": {
    "/path/to/project": {
      "node": "phase0",
      "routes": { "phase0": "<session-id>", "default": "<session-id>" }
    }
  }
}
```

Two state files keep names that predate the rename: the discovery file
(`$DSH_HOME/collab-bridge.json`, holding host/port/token/pid) and the audit log
(`$DSH_HOME/collab-bridge.log.jsonl`). The running host and existing tooling read them, so the names
were left alone; both are rewritten whenever the host restarts, so a value read from them describes
one moment only.

## The review contract

`dsh_review` is a checkpoint gate, so its rules are strict on purpose:

- The caller supplies a **package** (`package_id`, stage, objective, obligations, candidate paths,
  evidence) and receives a **nonce**.
- The reviewer must answer with `package_id` and `nonce` matching exactly. Verdicts that do not match
  are rejected, which is what stops a verdict from being reused on another candidate.
- `verdict` is `PASS` only when there are no findings and no unknowns.
- **`unknowns` force a non-`PASS`** result. An unknown is "I could not determine this", and it is not
  allowed to masquerade as a pass.
- The reviewer runs in a **read-only sandbox** and cannot write. Anything it therefore could not
  verify is reported separately as a **structural limit**, which is explicitly *not* a finding about
  the candidate and does not change the verdict.
- The candidate's identity is hashed before and after the review. If the tree changed while the
  reviewer was reading it, that is reported.

## Status and limits

- The reviewer is a headless DSH profile running an external model. It needs credentials on the
  device. The plugin detects an account grant in the credential store and otherwise needs
  `DSH_COLLAB_REVIEW_PROVIDER` / `DSH_COLLAB_REVIEW_MODEL`.
- Inbound relay framing text is written in Chinese, because the operator this was built for is
  Chinese-speaking. Everything else in the code is English.
- The offline suites (158 + 243 checks) are pure: no network, no provider call, no cost.
- Collabridge was extracted from one developer's working setup. It is published because the two
  problems it solves (reaching a live session, and getting a non-self verdict) are general, not
  because it is a finished product.

## License

MIT. See [LICENSE](LICENSE).
