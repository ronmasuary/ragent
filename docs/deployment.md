# Deploying Ragent on a Cloud VM

## What is Docker and why does Ragent use it?

**Docker** packages Ragent, Node.js, and all dependencies into one portable "box" called a **container**. That box runs identically on any Linux server — you don't install Node.js manually on the server, Docker brings it.

Without Docker you'd need to: install the right Node version, install dependencies, write a startup script, handle crashes, and hope the server's environment matches your dev machine. Docker removes all of that.

**Key concepts:**

| Term | Plain English |
|---|---|
| **Image** | The blueprint — a snapshot of your code + dependencies. Built from `Dockerfile`. |
| **Container** | A running instance of an image. Think of it as a lightweight VM. |
| **docker-compose** | A tool to configure and run containers via a YAML file (`docker-compose.yml`). Handles ports, volumes, restart policy. |
| **Volume** | A folder on the HOST machine mounted into the container. Data in a volume survives container rebuilds. |

---

## Prerequisites

A fresh Ubuntu VM (22.04 or 24.04 recommended).

```bash
# 1. Install Docker (official one-liner)
curl -fsSL https://get.docker.com | sh

# 2. Allow your user to run Docker without sudo
sudo usermod -aG docker $USER

# IMPORTANT: log out and log back in for the group change to take effect

# 3. Verify
docker --version        # Docker version 27.x.x
docker compose version  # Docker Compose version v2.x.x
```

---

## First-time setup

```bash
# Clone the repo (or git pull if already cloned)
git clone <your-gitlab-repo-url> ragent
cd ragent

# Create your .env file from the template
cp .env.example .env

# Edit .env — set at minimum:
#   ANTHROPIC_API_KEY=your-key-here
#   API_KEY=some-secret       # optional but recommended if port 3456 is open
nano .env

# Start the agent
./deploy.sh
```

The agent is now running. Check it:

```bash
curl http://localhost:3456/health
# → {"ok":true,"uptime":5}
```

---

## What `deploy.sh` does

```bash
git pull                          # pull latest code from your repo
docker compose up -d --build      # rebuild image + start in background
```

- `-d` = detached (runs in background, you get your terminal back)
- `--build` = rebuild the Docker image if `Dockerfile` or `package.json` changed
- `restart: always` in `docker-compose.yml` means the container auto-starts on VM reboot and auto-restarts on crash

---

## Day-to-day commands

```bash
# Watch live logs
docker compose logs -f

# Check if running
docker compose ps

# Restart the agent
docker compose restart ragent

# Stop the agent
docker compose down

# Deploy latest code
./deploy.sh
```

---

## Where data lives (volumes)

The container's internal filesystem is **temporary** — it resets on every `./deploy.sh`. Your data lives in volumes (folders on the HOST VM):

| Volume | What's stored |
|---|---|
| `./identities/` | Agent memory, conversation history (`history.jsonl`), shell audit log (`shell_audit.jsonl`) |
| `./skills/` | Installed skills |

These folders persist across deploys. Back them up if needed.

---

## Installing skills on the cloud VM

Skills are private (gitignored). You package them on your dev machine and install via the API.

```bash
# On your dev machine — zip FROM the skills/ directory (not from inside the skill dir)
cd /path/to/ragent/skills
zip -r /tmp/wallet-cli.skill wallet-cli/

# SCP to the VM
scp /tmp/wallet-cli.skill user@your-vm-ip:/tmp/

# SSH into the VM and install via the API
ssh user@your-vm-ip
curl -X POST http://localhost:3456/skills/install \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"path": "/tmp/wallet-cli.skill"}'
# → {"ok":true,"name":"wallet-cli","skills":[...]}
```

The agent unzips the `.skill` file into `skills/wallet-cli/`, runs `npm install` if needed, and hot-loads it immediately. No restart required.

> **Zip from the right directory.** The zip must contain the skill folder as a top-level entry (e.g. `wallet-cli/src/index.ts`). If you zip from _inside_ the skill directory (`cd wallet-cli && zip .`), the paths are wrong and installation fails.

---

## Firewall / network

By default, port 3456 is bound to all interfaces. On a cloud VM:

- **Close port 3456 to the internet** unless you set `API_KEY` and understand the risks (`shell_exec` runs as the container user)
- Access via SSH tunnel instead: `ssh -L 3456:localhost:3456 user@your-vm-ip`
- Telegram is the recommended remote interface — it uses outbound HTTPS only, no open port needed
