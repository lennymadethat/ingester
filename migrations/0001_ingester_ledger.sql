-- Ingester ledger. Run in the SAME Postgres as your Second Brain library
-- (github.com/lennymadethat/second-brain, migrations 0001-0004 first).
-- Two tables: one row per processed file, one row per agent run per file.

CREATE TABLE IF NOT EXISTS public.ingest_events (
    id              BIGSERIAL PRIMARY KEY,
    source_filename TEXT        NOT NULL,
    detected_type   TEXT,
    routed_project  TEXT,
    domain          TEXT,
    summary         TEXT,
    reasoning       TEXT,
    page            TEXT,          -- the library page written (or the filed key)
    moved_to        TEXT,          -- R2 key of the filed original
    status          TEXT        NOT NULL DEFAULT 'processed',
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_events_created_at_idx ON public.ingest_events (created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_runs (
    id              BIGSERIAL PRIMARY KEY,
    source_filename TEXT        NOT NULL,
    source          TEXT,          -- text | pdf | image | audio | video | binary
    agent           TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'done',
    summary         TEXT,
    outputs         JSONB,
    domain          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx ON public.agent_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_file_idx ON public.agent_runs (source_filename);

-- The Worker writes with the service-role key; nothing here is exposed to anon.
GRANT ALL ON public.ingest_events, public.agent_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ingest_events_id_seq, public.agent_runs_id_seq TO service_role;
