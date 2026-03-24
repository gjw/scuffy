/**
 * Minimal web frontend for Scuffy.
 *
 * Cookie-based sessions — each visitor gets a random session ID,
 * spawns a Scuffy child process, and talks to it over WebSocket.
 * Sessions expire after 1 hour.
 */

import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { WebSocketServer, type WebSocket } from "ws";
import http from "node:http";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const REAP_INTERVAL_MS = 60 * 1000; // check every minute
const PORT = Number(process.env.SCUFFY_PORT ?? 3000);

interface ManagedSession {
  id: string;
  proc: ChildProcess;
  ws: WebSocket | null;
  createdAt: number;
}

const sessions = new Map<string, ManagedSession>();

// --- Express app ---

const app = express();
app.use(cookieParser());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/", (req, res) => {
  const cookies = req.cookies as Record<string, string> | undefined;
  let sessionId = cookies?.scuffy_session;
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (!sessionId || !existing) {
    sessionId = crypto.randomUUID();
    res.cookie("scuffy_session", sessionId, {
      httpOnly: true,
      maxAge: SESSION_TTL_MS,
      sameSite: "lax",
    });
  }

  res.type("html").send(CHAT_HTML);
});

// --- HTTP + WebSocket server ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // Parse session cookie from upgrade request
  const cookieHeader = req.headers.cookie ?? "";
  const match = cookieHeader.match(/scuffy_session=([^;]+)/);
  const sessionId = match?.[1];

  if (!sessionId) {
    ws.close(4001, "No session cookie");
    return;
  }

  let session = sessions.get(sessionId);

  if (!session) {
    // Spawn a new Scuffy child process
    const proc = spawn("node", ["--import", "tsx", path.join(__dirname, "index.ts")], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    session = { id: sessionId, proc, ws, createdAt: Date.now() };
    sessions.set(sessionId, session);

    const s = session;
    const sid = sessionId;

    // Pipe stdout to WebSocket
    proc.stdout.on("data", (data: Buffer) => {
      if (s.ws?.readyState === 1) {
        s.ws.send(JSON.stringify({ type: "stdout", data: data.toString() }));
      }
    });

    // Pipe stderr to WebSocket
    proc.stderr.on("data", (data: Buffer) => {
      if (s.ws?.readyState === 1) {
        s.ws.send(JSON.stringify({ type: "stderr", data: data.toString() }));
      }
    });

    proc.on("exit", (code) => {
      if (s.ws?.readyState === 1) {
        s.ws.send(JSON.stringify({ type: "exit", code: String(code) }));
        s.ws.close();
      }
      sessions.delete(sid);
    });
  } else {
    // Reconnect: attach new WebSocket to existing session
    session.ws = ws;
  }

  const activeSession = session;

  // Messages from browser → Scuffy stdin
  ws.on("message", (msg: Buffer) => {
    const text = msg.toString();
    if (activeSession.proc.stdin?.writable) {
      activeSession.proc.stdin.write(text + "\n");
    }
  });

  ws.on("close", () => {
    activeSession.ws = null;
  });
});

// --- Session reaper ---

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      session.proc.kill();
      session.ws?.close();
      sessions.delete(id);
    }
  }
}, REAP_INTERVAL_MS);

// --- Start ---

server.listen(PORT, () => {
  console.log(`Scuffy web UI listening on http://localhost:${String(PORT)}`);
});

// --- Inline HTML ---

const CHAT_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scuffy</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 12px 16px; background: #16213e; border-bottom: 1px solid #333; font-size: 14px; }
  #header h1 { font-size: 16px; font-weight: bold; color: #e94560; }
  #output { flex: 1; overflow-y: auto; padding: 16px; white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.5; }
  .stdout { color: #e0e0e0; }
  .stderr { color: #e94560; }
  .user-input { color: #0f3460; background: #162447; padding: 2px 6px; border-radius: 3px; }
  #input-bar { display: flex; padding: 12px 16px; background: #16213e; border-top: 1px solid #333; gap: 8px; }
  #input { flex: 1; background: #0f3460; border: 1px solid #333; color: #e0e0e0; padding: 8px 12px; font-family: monospace; font-size: 13px; border-radius: 4px; outline: none; }
  #input:focus { border-color: #e94560; }
  #send { background: #e94560; color: white; border: none; padding: 8px 16px; font-family: monospace; font-size: 13px; border-radius: 4px; cursor: pointer; }
  #send:hover { background: #c73650; }
</style>
</head>
<body>
<div id="header"><h1>Scuffy</h1></div>
<div id="output"></div>
<div id="input-bar">
  <input id="input" type="text" placeholder="Talk to Scuffy..." autofocus>
  <button id="send">Send</button>
</div>
<script>
  const output = document.getElementById('output');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(protocol + '//' + location.host);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const span = document.createElement('span');
    if (msg.type === 'stdout') {
      span.className = 'stdout';
      span.textContent = msg.data;
    } else if (msg.type === 'stderr') {
      span.className = 'stderr';
      span.textContent = msg.data;
    } else if (msg.type === 'exit') {
      span.className = 'stderr';
      span.textContent = '\\n[Session ended]\\n';
    }
    output.appendChild(span);
    output.scrollTop = output.scrollHeight;
  };

  ws.onclose = () => {
    const span = document.createElement('span');
    span.className = 'stderr';
    span.textContent = '\\n[Disconnected]\\n';
    output.appendChild(span);
  };

  function send() {
    const text = input.value.trim();
    if (!text || ws.readyState !== 1) return;
    ws.send(text);
    const span = document.createElement('span');
    span.className = 'user-input';
    span.textContent = '> ' + text + '\\n';
    output.appendChild(span);
    output.scrollTop = output.scrollHeight;
    input.value = '';
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
</script>
</body>
</html>`;
