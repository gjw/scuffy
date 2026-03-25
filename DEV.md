# Dev Guide

## Deployment

Scuffy is deployed on a Linode VPS at `scuffy.foramerica.dev`.

**Server:** `root@agentforge` (SSH alias)

**Stack:**

- **Node 24** via nodenv (`.node-version` in repo root)
- **pm2** for process management
- **nginx** reverse proxy with TLS (certbot/Let's Encrypt)
- Repo cloned at `~/scuffy`

**Architecture:**

`src/serve.ts` is the web entry point (not `src/index.ts`). It runs an Express +
WebSocket server on port 3000. Each visitor gets a cookie-based session that spawns
a Scuffy child process (`src/index.ts`) with stdin/stdout bridged over WebSocket.
Sessions auto-expire after 1 hour.

**Key files:**

| File | Purpose |
|---|---|
| `src/serve.ts` | Web server (Express + WS + session management) |
| `deploy/scuffy.nginx.conf` | Reference nginx config (certbot manages the live one) |
| `deploy/scuffy.service` | Reference systemd unit (we use pm2 instead) |
| `deploy/setup.sh` | One-shot setup script (already run, kept for reference) |

**Common operations:**

```bash
# SSH in
ssh root@agentforge

# Check status
pm2 list
pm2 logs scuffy --lines 30 --nostream

# Deploy new code
cd ~/scuffy && git pull && pm2 restart scuffy

# Full restart
pm2 delete scuffy
cd ~/scuffy && pm2 start "node --import tsx src/serve.ts" --name scuffy --cwd /root/scuffy
pm2 save
```

**Other services on the same box:**

- `fleetgraph` (pm2, port 3100) — FleetGraph API at `fleetgraph.foramerica.dev`
- shipshape was removed from pm2 and nginx

**Environment:**

- `.env` on the server has `ANTHROPIC_API_KEY` (copied from local)
- `SCUFFY_PORT` defaults to 3000
- nginx config lives at `/etc/nginx/sites-enabled/scuffy`

## LLM Provider Setup

Scuffy supports Anthropic and OpenAI. Provider is selected by env vars in `.env`.

**Anthropic (default):**

```
ANTHROPIC_API_KEY=sk-ant-...
```

**OpenAI:**

```
OPENAI_API_KEY=sk-...
OPENAI_PROJECT=proj_...        # Optional but recommended for org billing tracking
SCUFFY_PROVIDER=openai
SCUFFY_MODEL=gpt-5.4           # or gpt-5.4-mini, gpt-5.4-pro, etc.
```

`SCUFFY_MODEL` is a freeform string passed directly to the provider SDK — there
is no hardcoded enum. Use any model ID the provider accepts. `OPENAI_PROJECT` is
read automatically by the OpenAI SDK for project-scoped billing; Scuffy's config
code does not need to know about it.

Model can be overridden per invocation via `loadConfig({ model: "gpt-5.4-pro" })`.
The summoner script and headless callers use this to assign heavier models to
planning tasks.

## MCP Agent Mail Integration

Scuffy connects to [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
for inter-agent and agent-to-human messaging. The server exposes 40+ MCP tools across
9 clusters. We whitelist only the tools we need to keep context lean.

**Starting the server:**

```bash
# Requires uv (https://docs.astral.sh/uv/)
./scripts/start-agent-mail.sh

# Or manually:
uvx --python 3.12 --from mcp_agent_mail python -m mcp_agent_mail.http --host 127.0.0.1 --port 8765
```

**Connecting Scuffy:**

```bash
SCUFFY_MCP_SERVERS='[{"name":"mail","transport":"http","url":"http://127.0.0.1:8765/mcp","tools":["send_message","fetch_inbox","register_agent","mark_message_read"]}]'
```

**Registering Scuffy as an agent:** Call the `register_agent` MCP tool with this
repo's absolute path as `project_key` and `"scuffy"` as agent name. This is a
one-time setup — the identity persists in the mail server's storage.

**Currently whitelisted:**

- `send_message` — flag Chair, message Tower/Warden
- `fetch_inbox` — check for human instructions at session start
- `register_agent` — one-time identity setup
- `mark_message_read` — housekeeping

**Available but not yet used — add when needed:**

| Cluster | Tools | Use case |
|---|---|---|
| **file_reservations** | `file_reservation_paths`, `release_file_reservations`, `renew_file_reservations` | Multi-Scuffy: prevent two agents editing the same files |
| **build_slots** | `acquire_build_slot`, `renew_build_slot`, `release_build_slot` | Signal long-running ops ("I'm running the test suite") |
| **search** | `search_messages`, `summarize_thread`, `summarize_recent` | Agent self-serve: "what did Tower say about auth?" |
| **contact** | `request_contact`, `respond_contact`, `list_contacts` | Cross-project agent linking |
| **workflow_macros** | `macro_start_session`, `macro_file_reservation_cycle` | Bundled multi-step flows for smaller models |
| **product_bus** | `ensure_product`, `products_link`, `fetch_inbox_product` | Cross-repo coordination (Ship API + Ship frontend as one product) |
| **identity** | `whois`, `list_window_identities` | Agent discovery ("who else is working?") |

**Web dashboard:** `http://localhost:8765/mail` — browse messages, search, compose
overseer messages to agents. The `/mail/{project}/overseer/compose` endpoint lets
Chair send high-priority instructions that override agent priorities.

## CASS Memory Integration

Scuffy connects to [CASS](https://github.com/Dicklesworthstone/cass_memory_system)
for procedural memory across rebuild attempts. Lessons from failed/successful sessions
are extracted via `cm reflect` and injected into the next attempt via `cm_context`.

**Starting the server:**

```bash
./scripts/start-cass.sh
# Or: cm serve --port 8766
```

**Connecting Scuffy:**

```bash
SCUFFY_MCP_SERVERS='[...,{"name":"cass","transport":"http","url":"http://127.0.0.1:8766/mcp","tools":["cm_context","cm_feedback","cm_outcome"]}]'
```

**How it works:**

1. Session start: headless system prompt tells Scuffy to call `mcp_cass_cm_context`
   with a task description to get relevant lessons from prior sessions
2. Session end: `finishBead` records success, `escalate` records failure via `cm_outcome`
3. Between attempts: run `cm reflect` to process session logs into playbook rules
4. Next attempt: Scuffy gets updated lessons automatically via `cm_context`

**Whitelisted tools:** `cm_context`, `cm_feedback`, `cm_outcome`

## Testing Notes

**Headless mode and bead workflow:** Headless mode (`--headless --instruction "..."`)
shares the system prompt with REPL, which includes bead workflow instructions. The
agent will claim and work on the next available bead rather than executing the literal
instruction text. This is by design for bead automation but means headless cannot
currently be used for ad-hoc one-shot tasks without a system prompt change.

**OpenAI token tracking:** OpenAI reports `cached_tokens` in
`usage.prompt_tokens_details` — this populates `cacheReadTokens`. There is no
`cacheWriteTokens` equivalent; it will always be 0 for OpenAI. Caching is automatic
on gpt-4o+ models for prompts ≥1024 tokens. First requests against a new prompt
will show `cache: 0r/0w`; subsequent requests within ~5-10 minutes will show cache
hits.
