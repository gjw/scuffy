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
