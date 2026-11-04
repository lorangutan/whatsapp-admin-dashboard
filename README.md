# Wamon

WhatsApp sales CRM + response-time (SLA) reports for small dealers, bengkel and motor bekas sellers.
Each sales agent links their own WhatsApp number; the owner sees every chat, replies from the
dashboard, tracks each lead through a pipeline, and gets a daily summary on WhatsApp.

> **Pilot only.** Numbers are linked through [Baileys](https://github.com/WhiskeySockets/Baileys), an
> unofficial WhatsApp Web client. This breaks WhatsApp's ToS and a number can be banned. Use it for
> 1:1 replies only (plus the owner's daily report) — **never for broadcasts or bulk sending**.
> Production should move to the official Cloud API with Coexistence; see `src/channels/types.ts`.

## Run locally

Data lives in [TiDB Cloud Serverless](https://tidbcloud.com) (free tier; any MySQL 8 compatible server works).
Create a cluster, then copy `.env.example` to `.env` and fill in `DATABASE_URL` — use a separate database
such as `wamon_dev` for development. The database and tables are created on first start.

```bash
npm install
npm run seed   # optional: 3 fake agents with a week of chats and CRM data (safe to re-run)
npm run dev    # http://127.0.0.1:3000
```

Without `ADMIN_PASSWORD` the dashboard is open, which is only allowed on localhost; set it to get the
login screen. WhatsApp sessions are stored in `DATA_DIR` (default `./data`).

Link a number: **Nomor WA → Hubungkan nomor**, then on the agent's phone open WhatsApp →
Perangkat tertaut → Tautkan perangkat and scan the QR. Recent history and the address book are
imported on that first link, so reports and contact names are there from day one.

## Run on a Windows PC + Cloudflare Tunnel (free)

Good for a pilot: the PC must stay on and logged in (set Sleep to *Never*).

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -DevEnv .env
```

It installs a clean copy from GitHub to `%LOCALAPPDATA%\Wamon\app`, asks for the dashboard password
(stored only in `%LOCALAPPDATA%\Wamon\wamon.env`, readable by your Windows account only), reuses the TiDB
cluster from your dev `.env` with a separate `wamon` database, and registers a hidden **Wamon** task that
starts at logon and restarts on crashes. It serves on `http://127.0.0.1:3100`.

Expose it with a Cloudflare Tunnel: in the Cloudflare dashboard → Zero Trust → Networks → Tunnels, create a
tunnel, run the `cloudflared service install …` command it shows in an *admin* PowerShell, and add a public
hostname (e.g. `app.yourdomain.my.id`) pointing to `http://localhost:3100`.
Update: `deploy\windows\update.ps1` · remove: `deploy\windows\uninstall.ps1` (both in `%LOCALAPPDATA%\Wamon\app`).

## Deploy (Oracle Cloud Always Free + TiDB)

The WhatsApp connections must stay open 24/7, so Wamon runs as one long-lived process on a server —
serverless hosts like Vercel can't hold them. An Oracle Cloud *Always Free* VM does the job at no cost.

1. **TiDB:** create a Serverless cluster (region Singapore, `ap-southeast-1`) and note the connection details.
2. **Server:** in Oracle Cloud create a VM — Ubuntu 24.04, shape `VM.Standard.A1.Flex` (Always Free),
   region Singapore. In its VCN security list add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
3. **Domain:** point a domain or free subdomain (e.g. DuckDNS, or a cheap `.my.id`) at the VM's public IP.
4. **Install:** SSH in and run
   ```bash
   curl -fsSL https://raw.githubusercontent.com/lorangutan/whatsapp-admin-dashboard/main/deploy/setup.sh -o setup.sh
   sudo bash setup.sh your-domain.example
   ```
   It installs Node 22 and Caddy, opens the firewall, clones the app to `/opt/wamon`, asks for the TiDB
   URL and dashboard password (stored only in `/etc/wamon.env`), and starts the `wamon` service with HTTPS.
5. **Update later:** `sudo bash /opt/wamon/deploy/update.sh`. Logs: `journalctl -u wamon -f`.

WhatsApp sessions live in `/var/lib/wamon` on the server; back it up or numbers must be re-linked after
a rebuild. Everything else is in TiDB.

## Features

| Area | What it does |
|---|---|
| **Inbox** | All numbers in one list: unread badges, "belum dibalas" filter, stage/agent filters, search by name/number/unit, infinite scroll. Reply from the dashboard through the number that owns the chat (optimistic send, retry on failure). `/` opens quick replies. |
| **Lead panel** | Per chat: stage, unit of interest, deal value, tags, follow-ups, internal notes, editable contact name. |
| **Lead capture** | A live message from a customer whose chat isn't triaged yet becomes a lead in "Baru". History-imported chats stay out of the pipeline until you add them. "Bukan lead" keeps friends/family out for good. |
| **Pipeline** | Kanban by stage with value totals and time-in-stage; drag & drop or right-click to move, with undo. |
| **Follow-up** | Reminders grouped Terlambat / Hari ini / Besok / Nanti; tick to complete; badge on the rail when due. |
| **Laporan** | SLA % per sales, median and first-response time, leads waiting, deals won, pipeline funnel. |
| **Daily report** | WhatsApp summary to the owner at a set time, including deals. |
| **Live** | Server-Sent Events push new messages, stage changes and connection status to open dashboards. |

Keyboard: <kbd>Ctrl/⌘ K</kbd> command palette (views, actions, chat search) · <kbd>↑</kbd><kbd>↓</kbd>
move between chats · <kbd>Enter</kbd> focus reply · <kbd>Esc</kbd> close panel/menu/chat · right-click
(long-press on touch) for quick actions.

Deliberately not included (yet): broadcasts/campaigns and chatbots (ban risk on an unofficial
connection; revisit with the Cloud API), payments, Instagram, lead reassignment between numbers.

## How SLA is measured (`src/sla`)

- **Turn**: a burst of customer messages, from the first one until the agent's first reply.
  Five messages in a row count as one wait, not five.
- **Business hours only**: a chat at 22:00 answered at 08:05 the next day counts as 5 minutes.
  Hours and time zone (WIB/WITA/WIT) are set in Pengaturan.
- **Off-hours exchanges** (asked and answered while closed, e.g. Sunday chat) count as on time but are
  left out of median/first-response, so they don't drag those numbers to zero.
- **First response**: a turn that opens a conversation (no messages in the previous 24 h).
- **SLA %** = turns answered within target ÷ (answered + still-unanswered-past-target).
- Agent messages with nothing pending (follow-ups, promos) don't count.

## Layout

| Path | What |
|---|---|
| `src/channels/` | `ChannelAdapter` interface, Baileys implementation, per-number connection manager |
| `src/db/` | Schema + migrations (multi-tenant ready: `shop_id` everywhere), queries |
| `src/sla/` | Pure SLA engine + tests (`npm test`) |
| `src/report/` | Report building, daily WhatsApp summary + scheduler |
| `src/events.ts` | Live event bus behind `/api/events` (SSE) |
| `src/server.ts` | REST API (`/api/...`), serves `public/` |
| `public/js/` | Dashboard as plain ES modules, no build step: `app` (shell, router, shortcuts), `inbox`, `convo` (conversation + lead panel), `pipeline`, `followups`, `reports`, `numbers`, `settings`, `palette`, `lib`, `store` |
| `public/css/app.css` | Design tokens (dark default, light via `prefers-color-scheme`) and components |

## Known gaps

- One shared dashboard password, no per-user accounts or roles yet; one shop per install. Keep
  `HOST=127.0.0.1` or put it behind HTTPS before exposing it.
- Pipeline stages are stored per shop but not editable in the UI yet.
- Media is recorded by type only (no files stored, no sending media).
- Customer chats are personal data under UU PDP — you'll need a privacy policy and retention rules
  before onboarding real shops.
