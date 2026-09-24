# KIT.md — paste this into your agent

Copy everything below the line into Claude Code, Codex, Cursor, or any agent
with a shell. It stands up the Ingester end to end on your Cloudflare account,
wired into your Second Brain library. Budget: about 20 minutes, plus a few
cents per file once it is running.

---

You are setting up **Ingester** (drop a file, get a memory) from
https://github.com/lennymadethat/ingester. It writes into a Second Brain
library (https://github.com/lennymadethat/second-brain), so that must exist
first. Work through every step, verify each one, and stop only when you need a
value from me. Never paste a secret into a committed file; secrets go in with
`wrangler secret put` (or `.dev.vars` locally, which is git-ignored).

**1. Confirm the library exists**

Ask me for the Second Brain project URL (`https://<ref>.supabase.co`) and where
the service-role key is. If I do not have a Second Brain yet, stop and point me
at its KIT.md first.

**2. Clone, install, configure**

```
git clone https://github.com/lennymadethat/ingester.git
cd ingester
npm install
```

Edit `wrangler.toml`:
- `SUPABASE_URL` = the library URL.
- `DOMAINS` = my worlds, as `key=description; key=description`. Ask me for
  them in one question; suggest three based on what I say I do.
- `OWNER_CONTEXT` = one line naming what I work on (ask), or leave empty.
- `ALLOWED_ORIGINS` = any browser origin that will call `/upload`, else leave it.
- `MODEL` = `claude-opus-5` unless I ask for a cheaper one (`claude-sonnet-5`).

**3. The ledger tables**

Run `migrations/0001_ingester_ledger.sql` in the library's Postgres (Supabase
SQL Editor, or `psql -f`). Confirm `ingest_events` and `agent_runs` exist.

**4. Cloudflare resources (once)**

```
npx wrangler login
npx wrangler r2 bucket create ingester-inbox
npx wrangler queues create ingester-jobs
npx wrangler queues create ingester-dlq
```

**5. Secrets**

```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put INGESTER_TOKEN        # generate: openssl rand -hex 32
```

**6. Deploy and verify**

```
npx wrangler deploy
curl https://<worker>.workers.dev/health
```

`health` must show `inbox: true`, `library: true`, `queue: true`, and
`llm.configured: true`. If any is false, fix it before going on.

**7. First file**

Write a short Markdown note about a project I named in step 2 and drop it:

```
curl -X POST "https://<worker>.workers.dev/upload?name=first-note.md" \
  -H "x-ingester-token: <token>" --data-binary @first-note.md
```

Then `POST /run?inline=1&limit=1` with the token and show me the returned log.
Confirm: a page exists at `wiki/sources/ingester/…` in the library, the
project page gained an `## Inbox roll-ups` bullet (or the review queue got a
line if no project matched), the original moved to `processed/<domain>/`, and
`ingest_events` has one row.

**8. Optional: drop from any device**

If I want a Drive folder as the front door, walk me through
`bridge/drive-to-inbox.gs` at script.google.com (paste, fill CONFIG, run
`installTrigger` once).

**9. Report**

Tell me: the worker URL, the domains configured, the model, which agents are
on, and what my first file produced. Remind me the token is a password and I
rotate it with `wrangler secret put INGESTER_TOKEN`. Remind me the Dream pass
runs Sundays and writes only proposals.
