# Tracker Snapshot Agent

Single-shot local agent for posting tracker workbook rows to eod-api. It reads both workbooks independently and exits; Task Scheduler wiring is intentionally separate.

## Setup

1. Copy `agent/.env.example` to `agent/.env`.
2. Set `API_BASE_URL`, `TRACKER_INGEST_TOKEN`, `ISE_WORKBOOK_PATH`, and `BLITZ_WORKBOOK_PATH`.
3. Keep `agent/.env` local only. It is gitignored and must not be committed.

## Manual Dry Run

From the repo root:

```powershell
node agent/run.js
```

A healthy two-kind run logs:

- `run started`
- `read complete` for `ise` and `blitz`
- `post complete` for each kind, usually with status `200`
- `run finished`

Logs are written to `agent/logs/tracker-agent.log` unless `LOG_DIR` is set. The log records counts and outcomes only; it does not log row contents or the ingest token.

## Force Test

To deliberately override the local floor and ask the server to accept a below-floor payload for one kind:

```powershell
node agent/run.js --force-kind ise
```

Force only applies after a successful workbook read. If the read throws, the kind is skipped and no POST is attempted, even when forced.
