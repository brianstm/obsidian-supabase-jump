# Self-hosting Supabase for SupaBase Jump

This guide walks you through running Supabase on your own machine or server and connecting SupaBase Jump to it. You don't need a supabase.com account for any of this.

If you just want things to work with the least effort, the free plan on [supabase.com](https://supabase.com) is still the easiest option. Self-hosting makes sense if you want your notes to never leave your own hardware, or you already run a home server.

## Contents

- [What you need](#what-you-need)
- [Step 1: Install Docker](#step-1-install-docker)
- [Step 2: Get Supabase running](#step-2-get-supabase-running)
- [Step 3: Change the default secrets](#step-3-change-the-default-secrets)
- [Lite setup for small servers (optional)](#lite-setup-for-small-servers-optional)
- [Step 4: Settings that matter for this plugin](#step-4-settings-that-matter-for-this-plugin)
- [Step 5: Make it reachable from your phone](#step-5-make-it-reachable-from-your-phone)
- [Step 6: Set up the database](#step-6-set-up-the-database)
- [Step 7: Connect the plugin](#step-7-connect-the-plugin)
- [Backups](#backups)
- [Updating Supabase](#updating-supabase)
- [Quick local test with the Supabase CLI](#quick-local-test-with-the-supabase-cli)
- [Troubleshooting](#troubleshooting)

## What you need

- A computer that stays on while you want to sync. A small home server, a NAS, a Raspberry Pi 4 or 5, or a cheap cloud VPS all work.
- At least 4 GB of RAM for the full Supabase stack (2 GB can work but is tight), or about 1 GB of free RAM for the [lite setup](#lite-setup-for-small-servers-optional). Plus about 10 GB of free disk space and room for your vault.
- Docker with Docker Compose.
- About 30 minutes.

SupaBase Jump uses these parts of Supabase, and they are all included in the standard self-hosted setup:

| Part      | What the plugin uses it for                 |
| --------- | ------------------------------------------- |
| Postgres  | Storing your notes and version history      |
| Auth      | Signing in with email and password          |
| Storage   | Images, PDFs and other attachments          |
| Realtime  | Instant sync and live editing               |
| Studio    | The dashboard where you run the setup SQL   |

## Step 1: Install Docker

Pick your platform.

### Linux server or VPS (Ubuntu, Debian and similar)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in so the group change applies, then check it works:

```bash
docker compose version
```

Any VPS with 4 GB of RAM is fine. Hetzner, DigitalOcean, Linode and Oracle Cloud's free tier have all been used for this kind of setup.

### macOS

Install one of these:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [OrbStack](https://orbstack.dev), which is lighter and faster on Apple Silicon

Open it once so it finishes setting up, then check in Terminal:

```bash
docker compose version
```

Keep in mind your Mac has to be awake for your other devices to sync. In **System Settings → Energy**, turn on the option to prevent sleeping when the display is off if you want it to act as a server.

### Windows

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and choose the WSL 2 backend when asked.
2. Open **PowerShell** and check it works:

```powershell
docker compose version
```

Run the commands in the rest of this guide inside a WSL terminal (open **Ubuntu** from the Start menu after installing it with `wsl --install`). Things run faster and the shell commands below work as written. Keep your Supabase folder inside the Linux side, for example `~/supabase-project`, not under `/mnt/c/`.

### Raspberry Pi

Use a Raspberry Pi 4 or 5 with at least 4 GB of RAM and the **64-bit** version of Raspberry Pi OS. The 32-bit version won't run the Supabase images. A USB SSD is much better than an SD card for a database.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in, then continue with step 2.

### NAS (Synology, Unraid, TrueNAS)

Most NAS systems can run Docker Compose projects:

- **Synology:** install **Container Manager**, then create a new **Project** and point it at the folder from step 2.
- **Unraid:** install the **Docker Compose Manager** plugin and add a new stack.
- **TrueNAS SCALE:** use a custom app or run the commands over SSH.

If you are not sure, enable SSH on your NAS and follow the Linux steps. They work the same way.

## Step 2: Get Supabase running

These commands come from the [official self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker). Check it if anything below doesn't match what you see, since Supabase updates it now and then.

```bash
git clone --depth 1 https://github.com/supabase/supabase
mkdir supabase-project
cp -rf supabase/docker/* supabase-project
cp supabase/docker/.env.example supabase-project/.env
cd supabase-project
docker compose pull
```

Don't start it yet. Change the secrets first.

## Step 3: Change the default secrets

The example `.env` file ships with demo passwords and keys that everyone knows. Always change them before your server is reachable from anywhere.

Open `.env` in a text editor:

```bash
nano .env
```

Change at least these:

| Setting              | What to put there                                                     |
| -------------------- | --------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | A long random password                                                |
| `JWT_SECRET`         | A random string of at least 32 characters                             |
| `ANON_KEY`           | A key generated from your `JWT_SECRET` (see below)                    |
| `SERVICE_ROLE_KEY`   | A key generated from your `JWT_SECRET` (see below)                    |
| `DASHBOARD_USERNAME` | The username for the Studio dashboard                                 |
| `DASHBOARD_PASSWORD` | A strong password for the dashboard                                   |

A quick way to make random values:

```bash
openssl rand -base64 48
```

The `ANON_KEY` and `SERVICE_ROLE_KEY` are signed with your `JWT_SECRET`, so they have to be made from it. The easiest way is the script that ships with Supabase. It makes every secret and key at once and writes them into `.env`:

```bash
sh utils/generate-keys.sh --update-env
```

You still need to set `DASHBOARD_USERNAME` yourself. If your copy of Supabase doesn't have `utils/generate-keys.sh`, use the key generator in the "Securing your services" section of the official guide instead.

If you want the lighter version, set it up now (see [Lite setup for small servers](#lite-setup-for-small-servers-optional)) before you start anything.

Then start everything:

```bash
docker compose up -d
```

Give it a minute, then check that every service says it is running or healthy:

```bash
docker compose ps
```

Open `http://localhost:8000` (or `http://<server-ip>:8000`) in a browser. You should see a login prompt for Studio. Use the dashboard username and password you set.

With the lite setup, Studio is off and the API only answers on the server itself. Check it there instead. This should print a short piece of JSON:

```bash
curl -s http://127.0.0.1:8000/auth/v1/.well-known/jwks.json
```

## Lite setup for small servers (optional)

The standard Supabase setup starts about a dozen containers, and several of them are things this plugin never uses: image resizing, edge functions, the connection pooler and, most of the time, the Studio dashboard. On a home server, a Raspberry Pi or a small VPS you can skip them and cap the memory of the rest. My current setup idled at about **800 MB** with this.

| Part              | Lite setup                | Why                                              |
| ----------------- | ------------------------- | ------------------------------------------------ |
| Postgres          | Always on (1 GB cap)      | Your notes and version history                   |
| Auth              | Always on                 | Signing in                                       |
| PostgREST         | Always on                 | Reading and writing notes                        |
| Realtime          | Always on                 | Instant sync, live editing and cursors           |
| Storage           | Always on                 | Attachments                                      |
| API gateway       | Always on                 | The one address the plugin talks to              |
| Studio + meta     | Only when you need them   | The dashboard, used for the setup SQL            |
| imgproxy          | Off                       | The plugin doesn't resize images                 |
| Edge Functions    | Off                       | Not used                                         |
| Supavisor pooler  | Off                       | Not needed for one user, and it publishes Postgres |

You need Docker Compose 2.24 or newer. Check with `docker compose version`.

1. In your `supabase-project` folder, download the lite file from this repo:

```bash
curl -fsSL https://raw.githubusercontent.com/brianstm/obsidian-supabase-jump/main/self-hosting/docker-compose.lite.yml -o docker-compose.lite.yml
```

2. Tell Docker Compose to use it on top of the official file. Open `.env` and change the `COMPOSE_FILE` line (add it if it isn't there):

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.lite.yml
```

3. Check that it lines up with your version of Supabase. You should see exactly these six services:

```bash
docker compose config --services
```

`api-gw`, `auth`, `db`, `realtime`, `rest` and `storage`. If you get an error instead, your Supabase version names a service differently, so compare the names with the lite file.

4. Start it as usual with `docker compose up -d`.

A few things work differently in the lite setup:

- **The API only listens on the server itself** (`127.0.0.1`). Docker skips most firewalls like ufw when it publishes a port, so this keeps your database API off your home network. Reach it through Tailscale, Cloudflare Tunnel or Caddy (step 5), even from a desktop on the same network.
- **Studio is off.** Start it when you need the dashboard and stop it afterwards to free about 400 MB (commands below). You can also skip Studio completely and run the setup SQL from the command line (see step 6).
- **Each part has a memory cap.** If a container keeps restarting, raise its `mem_limit` in `docker-compose.lite.yml` and run `docker compose up -d` again. `docker stats --no-stream` shows how close each one is to its cap.
- **The attachment size limit** is set in `docker-compose.lite.yml` (`FILE_SIZE_LIMIT`, 100 MB by default).

Starting and stopping Studio in the lite setup:

```bash
docker compose --profile studio up -d studio meta   # start
docker compose --profile studio stop studio meta    # stop
```

While it's running, open your project URL in a browser and log in with the dashboard username and password.

## Step 4: Settings that matter for this plugin

A few more lines in `.env` make the plugin work smoothly.

**Skip email confirmation.** Unless you set up an email server, Supabase can't send confirmation emails, and you won't be able to sign in. Since you are the only user, turn confirmation off:

```env
ENABLE_EMAIL_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=true
```

If you want nobody else to be able to create an account on your server, create your account first (step 7), then set `ENABLE_EMAIL_SIGNUP=false`.

**Set your public address.** Once you know the address you'll reach Supabase on (step 5), put it in these:

```env
API_EXTERNAL_URL=https://supabase.example.com
SUPABASE_PUBLIC_URL=https://supabase.example.com
SITE_URL=https://supabase.example.com
```

**Attachment size limit.** The storage service has a file size limit, set with `FILE_SIZE_LIMIT` in `docker-compose.yml` (in bytes, 52428800 is 50 MB), or in `docker-compose.lite.yml` if you use the lite setup. Raise it if you keep big videos or PDFs in your vault, and match the **Largest file to sync** setting in the plugin.

After changing `.env` or `docker-compose.yml`, restart:

```bash
docker compose down
docker compose up -d
```

## Step 5: Make it reachable from your phone

At this point Supabase works on `http://<server-ip>:8000`. That is fine for a desktop on the same network, but phones need a bit more:

- iPhone and iPad block plain `http://` addresses in most cases, so you need `https://`.
- If you want to sync away from home, your phone has to reach the server from outside your network.

With the lite setup, the API only answers on the server itself, so every device, including a desktop on the same network, connects through one of the options below.

Pick one of these. They all handle the websocket connection that live editing uses.

### Option A: Tailscale (easiest, private)

[Tailscale](https://tailscale.com) puts your devices on a private network with no ports to open. Only your own devices can reach the server.

1. Install Tailscale on the server and on every device you use Obsidian on, and sign in with the same account.
2. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**.
3. On the server, run:

```bash
sudo tailscale serve --bg 8000
```

It prints an address like `https://my-server.tail1234.ts.net`. That's your project URL. Your phone needs the Tailscale app running to sync.

If something else on the server already uses Tailscale's port 443, pick another port. The project URL then includes it, for example `https://my-server.tail1234.ts.net:6443`:

```bash
sudo tailscale serve --bg --https=6443 http://127.0.0.1:8000
```

### Option B: Cloudflare Tunnel (no open ports, works anywhere)

Good if you already use Cloudflare for a domain.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels** and create a tunnel.
2. Run the install command it shows you on the server.
3. Add a public hostname, for example `supabase.example.com`, pointing to `http://localhost:8000`.

Cloudflare's free plan limits uploads to 100 MB per request, so keep the plugin's file size limit below that.

### Option C: Your own domain with Caddy

Use this on a VPS with a public IP, or at home if you can forward ports 80 and 443 to the server.

1. Point a DNS record like `supabase.example.com` at your server's IP.
2. Install [Caddy](https://caddyserver.com/docs/install).
3. Put this in `/etc/caddy/Caddyfile`:

```
supabase.example.com {
	reverse_proxy localhost:8000
}
```

4. Reload Caddy:

```bash
sudo systemctl reload caddy
```

Caddy gets an HTTPS certificate for you automatically.

Whichever option you pick, go back to step 4 and put the new `https://` address into `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL` and `SITE_URL`, then restart.

**Never expose the Postgres port (5432) to the internet.** The plugin only needs port 8000, through one of the options above. In the standard setup the pooler publishes 5432 and 6543 on every network interface, and Docker opens them even if your firewall says no. The lite setup doesn't publish them at all.

## Step 6: Set up the database

The one-click setup in the plugin only works with supabase.com projects, so on a self-hosted server you run the SQL yourself. It only takes a minute.

**Wait until Realtime is healthy first.** On a brand new install, Realtime creates its own tables a little while after it starts. If you run the SQL before that, the rules for private live editing channels are skipped without any error, and live editing and cursors won't work. Check with `docker compose ps`: `realtime` should say `healthy`. If you're not sure, run the SQL again later. It's always safe to run twice.

1. In Obsidian, open **Settings → SupaBase Jump → Database setup** and press **Copy SQL**. You can also run **Copy database setup SQL** from the command palette.
2. Open Studio in your browser and go to the **SQL Editor**.
3. Paste the SQL and press **Run**.

You should see "Success. No rows returned". The SQL is safe to run again, so do it after plugin updates that mention database changes.

**No Studio, or using the lite setup?** Save the SQL to a file on the server (for example `nano setup.sql` and paste), then run it from the `supabase-project` folder:

```bash
docker compose exec -T db psql -h localhost -v ON_ERROR_STOP=1 -U postgres -d postgres < setup.sql
```

To check it worked, this should list two "live channels" rules and `vault_files`:

```bash
docker compose exec -T db psql -h localhost -U postgres -d postgres \
  -c "select policyname from pg_policies where schemaname = 'realtime';" \
  -c "select tablename from pg_publication_tables where pubname = 'supabase_realtime';"
```

If you ran the SQL again because live editing wasn't working, fully quit and reopen Obsidian on every device afterwards (see [Troubleshooting](#troubleshooting)).

It creates the notes table, version history, the attachments bucket, and the security rules for files and live editing channels.

## Step 7: Connect the plugin

In **Settings → SupaBase Jump**:

1. **Project URL:** your address from step 5, for example `https://my-server.tail1234.ts.net`. Leave off any trailing path.
2. **Anon key:** the `ANON_KEY` from your `.env`. Never use the `SERVICE_ROLE_KEY` here.
3. **Email** and **Password:** pick any. The first time you press connect, the account is created for you.
4. **Vault ID:** press **Generate**, or type your own. Use the same one on every device.
5. Press **Connect**.

The status bar should say **Synced** within a few seconds. Repeat on your other devices with the same details.

## Backups

Your notes live in Postgres and your attachments live in the `volumes/storage` folder. Back up both.

Dump the database:

```bash
docker compose exec db pg_dump -U postgres postgres > backup-$(date +%F).sql
```

Copy the attachments:

```bash
tar czf storage-$(date +%F).tar.gz volumes/storage
```

To run the database backup every night at 3 am, add a line with `crontab -e`:

```
0 3 * * * cd ~/supabase-project && docker compose exec -T db pg_dump -U postgres postgres > ~/backups/supabase-$(date +\%F).sql
```

Keep at least one copy somewhere other than the server itself. Don't rely on copying `volumes/db/data` while Postgres is running. Those files can be caught halfway through a write, so back up the dump instead.

To restore a dump into a running instance:

```bash
docker compose exec -T db psql -h localhost -U postgres -d postgres < backup-2026-11-20.sql
```

## Updating Supabase

```bash
cd supabase-project
docker compose pull
docker compose up -d
```

Make a backup first. Every so often, compare your `docker-compose.yml` with the latest one in the Supabase repo, since new versions sometimes add settings. If your copy of Supabase has an `update.sh` script, it can do this for you.

If you use the lite setup, run `docker compose config --services` after every update. It should still list the same six services. If a release renames one, download the latest `docker-compose.lite.yml` from this repo.

## Quick local test with the Supabase CLI

If you just want to try things on one computer, the [Supabase CLI](https://supabase.com/docs/guides/local-development) is quicker. It is meant for development, not for daily syncing.

```bash
npx supabase init
npx supabase start
```

It prints an **API URL** (usually `http://127.0.0.1:54321`), an **anon key**, and a **Studio URL**. Run the setup SQL in that Studio, then use the API URL and anon key in the plugin. Email confirmation is off by default here. Stop it with `npx supabase stop`.

## Troubleshooting

**The plugin says "could not connect" or nothing happens.** Open your project URL in the browser on the same device. If it doesn't load there, the problem is the network or the address, not the plugin. On a phone, check that Tailscale is connected if you use it.

**It works on my computer but not on my iPhone.** You are probably using an `http://` address. Switch to one of the HTTPS options in step 5.

**"Email not confirmed".** Set `ENABLE_EMAIL_AUTOCONFIRM=true`, restart, and press connect again. If you already created the account, you can confirm it in Studio under **Authentication → Users**.

**Files sync but live editing doesn't.** Your proxy may be blocking websockets. Tailscale, Cloudflare Tunnel and Caddy all pass them through by default. With nginx, add the `Upgrade` and `Connection` headers for websocket proxying. Also check `docker compose ps` to make sure the realtime container is healthy.

To test the websocket on the server itself, run this from the `supabase-project` folder. It should print `HTTP/1.1 101 Switching Protocols`:

```bash
ANON=$(grep ^ANON_KEY= .env | cut -d= -f2)
curl -s -i -m 5 --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG9Xb3JsZDEyMzQ1Ng==" \
  "http://127.0.0.1:8000/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0" | head -1
```

Run the same command on another device with your project URL in place of `http://127.0.0.1:8000` to test the whole path through your proxy.

**Sync is instant but there are no cursors or presence badges.** The private live channel rules are probably missing, usually because the setup SQL ran before Realtime was ready (see [step 6](#step-6-set-up-the-database)). When a device can't join a private channel, the plugin switches to a public channel for the rest of that session and logs `private live channels aren't set up on this project, using public ones` in the developer console. Devices on different kinds of channel can't see each other. Run the setup SQL again, then fully quit and reopen Obsidian on every device (on iPhone, swipe it away in the app switcher). Also check that **Live editing** and **Show other cursors** are on in the plugin settings.

**A container keeps restarting (lite setup).** It's probably hitting its memory cap. `docker stats --no-stream` shows usage next to each limit. Raise that container's `mem_limit` in `docker-compose.lite.yml` and run `docker compose up -d`.

**"Port is already allocated" when starting.** Something else on the server uses port 8000. Set `API_GW_HTTP_PORT` in `.env` to a free port, for example `8100`, and point your proxy at that port instead.

**Attachments fail to upload.** Raise `FILE_SIZE_LIMIT` (step 4), and check any proxy upload limits (Cloudflare free is 100 MB, nginx defaults to 1 MB until you set `client_max_body_size`).

**"Database is missing a few new columns".** Run the setup SQL again from step 6.

**Something else.** Look at the logs:

```bash
docker compose logs -f --tail=100
```

and open an issue on [GitHub](https://github.com/brianstm/obsidian-supabase-jump/issues) with what you find. Remember to remove your keys and addresses first.
