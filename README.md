# CentralSquawk API

Central SSR code assignment for the French FIRs. Ingests the VATSIM datafeed,
decides every code, and serves `callsign -> {ssr, dupe}` to EuroScope plugins.

- **How it works:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **What the rules are:** the [plugin README](https://github.com/AlexisBalzano/CentralSquawk)
- **Config and navdata:** [CentralSquawk-config](https://github.com/AlexisBalzano/CentralSquawk-config)

## Running it locally

Use the local overlay. It serves the `CentralSquawk-config` checkout sitting
beside this repository instead of cloning from GitHub, so an edit to
`config.json` or a freshly regenerated `fix.txt` needs only a container restart
rather than a commit and a push:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

No `.env` is needed for this: an empty `AUTH_SECRET` disables token
verification, and `WARMUP_CYCLES=0` skips the warm-up so the snapshot is live
after the first tick.

The config directory is mounted **read-only** on purpose. The fetch path in
`init-config.sh` runs `git reset --hard`, which against a bind-mounted working
tree would discard uncommitted work on the host. `CONFIG_SKIP_FETCH=1` disables
that path and the read-only flag stops a future change quietly re-enabling it.

Without Docker at all:

```bash
npm install && CONFIG_DIR=../CentralSquawk-config npm run dev
```

## Running it against the real config repository

```bash
cp .env.example .env   # then fill in AUTH_SECRET and GH_SECRET
docker compose up --build
```

This clones `CONFIG_REPO_URL` into a named volume at boot and pulls it in place
when the webhook fires. **Every file the loader needs must be committed and
pushed** — `config.json`, `modes_area.geojson`, and all three navdata files.
`init-config.sh` checks for them and refuses to start if any are missing, which
is a far clearer failure than an exception inside the loader.

## Notes

Redis is optional. Without it the service runs degraded: the map is rebuilt from
the datafeed on every start, and manual overrides do not survive a restart.

`GET /api/squawks` answers `503` until the first full reconciliation sweep
completes, which takes `WARMUP_CYCLES` datafeed cycles (about 30 s by default).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Status, navdata cycle, pool utilisation, last tick |
| `GET /api/squawks` | The snapshot, gzipped |
| `POST /api/assign` | Manual set-code or force-reassign |
| `POST /api/config-webhook` | HMAC-verified config reload |

```jsonc
// GET /api/squawks
{ "AFR1234": { "ssr": "7201", "dupe": false } }

// POST /api/assign  -- omit "code" to force a reassignment instead
{ "callsign": "AFR1234", "controller": "LFFF_CTR", "token": "<sha256>", "code": "7201" }
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Watch mode via tsx |
| `npm test` | Engine invariant tests, no config repo needed |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |

## Before production

The code ranges in the config repository's `config.json` are **placeholders**.
Replace them with the real French ORCAM allocations and exclusion lists first —
see *Known gaps* in [ARCHITECTURE.md](ARCHITECTURE.md).
