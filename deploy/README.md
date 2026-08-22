# Deployment notes

4gent is a single-process, single-writer agent. It is designed for one bare-metal
Linux box or a small VM, not for a container fleet: the SQLite database, the
nonce manager and the kill switch all assume exactly one instance is running.

Running two instances against the same wallet will double-send transactions.

## Provisioning

```bash
sudo useradd --system --home /opt/4gent --shell /usr/sbin/nologin 4gent
sudo mkdir -p /opt/4gent/{data,logs}
sudo chown -R 4gent:4gent /opt/4gent
```

Node 22 or newer is required. Install pnpm via corepack.

## Install

```bash
cd /opt/4gent
git clone https://github.com/4gentio/4gent .
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
sudo chmod 600 .env && sudo chown 4gent:4gent .env
```

Fill in `.env`. The wallet key is read from the environment and never written to
the database or the logs; `EnvironmentFile=` in the unit keeps it out of the
process list.

## Database

```bash
sudo -u 4gent pnpm db:migrate
```

Migrations are idempotent and run automatically at boot as well.

## Service

```bash
sudo cp deploy/4gent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 4gent
journalctl -u 4gent -f
```

## Dashboard

The dashboard binds to `127.0.0.1` by default. Do not expose it directly. Reach
it over an SSH tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 user@host
```

## Backups

The database is the complete audit trail: every reasoning cycle, every fill,
every NAV point. Back it up with the SQLite backup API rather than copying the
file while the agent is writing:

```bash
sqlite3 /opt/4gent/data/4gent.db ".backup '/opt/4gent/backups/4gent-$(date +%F).db'"
```

## Upgrades

```bash
sudo systemctl stop 4gent      # drains in-flight transactions first
cd /opt/4gent && git pull && pnpm install --frozen-lockfile && pnpm build
sudo -u 4gent pnpm db:migrate
sudo systemctl start 4gent
```

Stopping mid-swap is safe: pending transactions are recorded before broadcast
and reconciled against the chain on the next boot.
