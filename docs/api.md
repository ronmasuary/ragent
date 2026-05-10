# API Reference — Ragent HTTP Server

Base URL: `http://localhost:3456`

## Authentication

Optional. Set `API_KEY` in `.env` to enable.

When enabled, protected endpoints require the `X-Api-Key` header:

```
X-Api-Key: your-key-here
```

Returns `401 Unauthorized` if missing or wrong.

**Protected:** `/chat`, `/chat/stream`, `/instructions`, `/history`, `/skills/*`, `/shell-audit`

**Public (no auth):** `/health`, `/status`, `/identity`

---

## GET /health

Liveness check.

**Response:**
```json
{ "ok": true, "uptime": 42 }
```

---

## GET /status

Agent info.

**Response:**
```json
{
  "name": "wally",
  "uptime": 120,
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "skills": ["wallet"]
}
```

---

## GET /identity

Identity JSON.

**Response:**
```json
{
  "id": "uuid-v4",
  "name": "wally",
  "createdAt": "2026-04-30T00:00:00.000Z",
  "capabilities": ["wallet"]
}
```

---

## POST /chat

Send a message to the agent. Blocking. Mutex — returns 409 if agent is busy.

**Request:**
```json
{ "message": "what can you do?" }
```

**Response:**
```json
{ "response": "I can help you with..." }
```

**Errors:**
- `400` — missing `message`
- `409` — agent busy
- `500` — agent error or timeout

---

## POST /chat/stream

SSE streaming response. Same mutex as `/chat`.

**Request:** same as `/chat`

**Events:**
```
event: done
data: {"response":"..."}

event: error
data: {"error":"..."}
```

---

## POST /instructions

Load a markdown instruction file. Agent reads, confirms, and waits.

**Request — markdown body:**
```
Content-Type: text/markdown

# Instructions
Install the wallet skill...
```

**Request — file path:**
```json
{ "path": "/abs/path/to/instructions.md" }
```

**Response:**
```json
{ "response": "I understand. Here's what I plan to do: ..." }
```

After this, send `/chat` with "proceed" or "confirm" to execute.

---

## GET /history

**Query params:**
- `?n=20` — last N turns (from in-memory buffer)
- `?since=<ISO>` — all entries after timestamp (from disk)

**Response (n=):**
```json
{ "turns": [{ "role": "user", "content": "hi" }] }
```

**Response (since=):**
```json
{ "entries": [{ "ts": "...", "role": "user", "content": "hi" }] }
```

---

## GET /skills

List loaded skills.

**Response:**
```json
{
  "skills": [
    { "name": "wallet", "version": "1.0.0", "tools": ["send_transaction"] }
  ]
}
```

---

## POST /skills/reload

Trigger a manual re-scan of `skills/` for new skill directories.

**Response:**
```json
{ "ok": true, "skills": [...] }
```

---

## POST /skills/install

Install a `.skill` file (zip archive) from an absolute path on the server.

**Request:**
```json
{ "path": "/tmp/my-skill.skill" }
```

**Response:**
```json
{ "ok": true, "name": "my-skill", "skills": [...] }
```

**Errors:**
- `400` — missing path, invalid extension, or skill already installed
- `503` — skill installation not configured

**How to package and install a skill:**
```bash
# On dev machine — zip FROM the skills/ directory
cd /path/to/ragent/skills
zip -r /tmp/my-skill.skill my-skill/

# Option A: SCP to server, then install via API
scp /tmp/my-skill.skill user@server:/tmp/
curl -X POST http://localhost:3456/skills/install \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"path": "/tmp/my-skill.skill"}'

# Option B: Download on server using download_file tool (binary-safe),
# then install via install_skill tool — no SCP required
```

> **Note:** Use the `download_file` built-in tool (not `fetch_url`) to download `.skill` files on the server. `fetch_url` reads responses as text and will corrupt binary ZIPs.

---

## GET /shell-audit

Last N shell commands executed via HTTP or Telegram.

**Query params:** `?n=20`

**Response:**
```json
{
  "entries": [
    {
      "ts": "2026-04-30T12:00:00.000Z",
      "command": "npm install",
      "cwd": "/Users/mac/Wikey/ragent",
      "exitCode": 0,
      "interface": "http"
    }
  ]
}
```
