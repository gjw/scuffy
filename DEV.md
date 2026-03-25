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
