# jev/: Jev for The Orchestrator and a second client app

## Status: paused

The owner paused all Jev work in The Orchestrator on 2026-09-30. The model work
continues in the upstream Jev project.

- Nothing here is installed, running or rented. $0 spent.
- `jev/local/install.sh` has never run. There is no launchd job, no
  `~/.config/jev/` directory, no Verda account and no box.
- The watch-only step calls nothing while `~/.config/jev/` has no `local.json`
  and no `state.json`. It writes no `jev_watch` rows.
- Everything below describes how it would be set up. It is kept for later.
- Do not install the local server or run `jev up` unless the owner asks for it again.

CLAUDE.md's Jev bullet still says "Jev runs locally for now". This README is
the accurate one until that line is updated.

## Local (the owner's Mac), never installed

This is the plan the owner chose before the pause: Jev on their Mac, nothing
rented.
It was never installed. The Verda sections below
(`jev up|down|status|dry-run`, the cap, the watchdog) are the other path, also
never run.

- **What would run.** The Laya typed-decisions server (Laya 421M, model
  `typed-decisions`), through `jev/local/serve_local.py`. It speaks the System
  One wire (`POST /v1/systemone`) itself and uses about 1.5 GB of memory (RSS).
- **Port 8766, on 127.0.0.1 only.** Port 8765 is reserved for another local
  server, the other app's own test server, which starts and stops it. The two
  are never shared. `serve_local.py` refuses to start on 8765, and The
  Orchestrator refuses a `local.json` that names it.
- **CPU only.** MLX and MPS caused kernel panics on this Mac. The device is
  the literal `"cpu"` in `serve_local.py`, and there is no option to change
  it. Never add one.
- **No key.** The Laya server has no auth and is bound to loopback, so The
  Orchestrator sends no `Authorization` header to it. The rented box keeps
  its bearer keys.
- **`~/.config/jev/local.json`** (0600) tells The Orchestrator where to ask:
  `{"baseUrl":"http://127.0.0.1:8766","model":"typed-decisions"}`. Only
  `http://127.0.0.1:<port>` is accepted (`jevwatch.ts` jevLocalConfig). A
  valid `local.json` wins over the box's `state.json`. Without it, and with
  no box up, nothing is asked.
- **When the server is down.** A refused connection writes no `jev_watch` row,
  and nothing is tried again for 5 minutes. Any other failure (a timeout past
  the 2 s cap, an HTTP error, a reply that is not JSON) is recorded as before.

```sh
jev/local/install.sh install            # loads the launchd job, writes local.json; does not start it
jev/local/install.sh install --at-login # the same, and launchd starts it now and at each login
jev/local/install.sh start              # launchctl kickstart
jev/local/install.sh stop               # launchctl kill TERM
jev/local/install.sh status             # launchd's state and GET /health (2 s)
jev/local/install.sh uninstall          # bootout, removes the plist and local.json
jev/local/install.sh render             # prints the plist, writes nothing
```

`install` needs the runtime at `~/.bb/thread-storage/jev-ai/runtime` (override
with `JEV_RUNTIME`) with `venv/bin/python` in it. It refuses under 30% free
memory or 5 GB free disk, and refuses to run from a task worktree. `HF_HOME`
is `<runtime>/hf` (override with `JEV_HF_HOME`); the runtime's own `env.sh`
is the reference for it. The job is
`~/Library/LaunchAgents/com.theorchestrator.jev-local.plist`, and it logs to
`~/.config/jev/local.log`. After a crash launchd is meant to start it again,
at most once a minute. `stop` is meant to leave it stopped; that is unchecked
(see UNVERIFIED).

**Why launchd.** Only launchd starts the server, never the script and never
an agent. The process is then launchd's child: it is not a descendant of The
Orchestrator's agents and carries no `BB_THREAD_ID`, so it is outside the
agent tree budget and the memory guard does not kill it.

UNVERIFIED: `install.sh` has never run, so the launchd job, `/health` and the
1.5 GB figure under launchd are unchecked on the real machine. The full list
is in UNVERIFIED at the end.

## The rented box (Verda), never rented, kept for later

`node jev/cli.ts up|down|status|dry-run` rents one Verda box in Helsinki. The
box serves a Jev-compatible typed-decision model over the System One wire
(`POST /v1/systemone`), behind Caddy TLS, with one bearer key per client. The
box **deletes itself** after 15 idle minutes or 4 hours. The spend is capped
at $20.

**`jev up` rents a machine and spends money. It never runs without the owner's ok.**

```sh
node jev/cli.ts dry-run   # walks up then down against canned answers: no network, no ~/.config/jev; exits 0
node jev/cli.ts status    # state, ledger vs the cap, balance and instance (with creds), health (2 s)
node jev/cli.ts up        # needs a picked model and Verda creds (below)
node jev/cli.ts down      # deletes the box, confirms it gone, writes the ledger row
```

Exit codes: 0 ok · 2 usage · 3 credentials missing · 4 delete not confirmed
(delete it at console.verda.com) · 5 no capacity in Helsinki · 6 refused (no
model, the cap, the price, a box still recorded) · 7 failed after create (the
box was torn down).

## Before the first `up` (the owner)

1. **Pick the model.** There is no default, so `up` refuses with "The owner
   hasn't picked the Jev model yet (open question)" until
   `~/.config/jev/config.json` names one:

   | model | machine | list price |
   | --- | --- | --- |
   | `laya-421m` | `CPU.4V.16G` | $0.048/h |
   | `anyjev-qwen3-8b` | `1A6000.10V` (RTX A6000 48 GB) | $0.64/h |

   ```sh
   mkdir -p -m 700 ~/.config/jev && echo '{"model":"anyjev-qwen3-8b"}' > ~/.config/jev/config.json
   ```
2. **Verda credentials.** Create them in a separate Verda project named
   **jev**: console → Credentials → Cloud API credentials. Put them in
   `~/.config/jev/verda.env` (mode 0600) as `VERDA_CLIENT_ID=…` and
   `VERDA_CLIENT_SECRET=…`, through the secrets flow, never in chat. The CLI
   never writes that file.
3. **Balance.** Add $20 prepaid. **Keep auto top-up off**: at zero balance
   Verda discontinues the instance, which is Verda's own hard cap.

## Files (`~/.config/jev/`, dir 0700, files 0600)

| File | What |
| --- | --- |
| `config.json` | `{"model": …}`, the owner's pick |
| `verda.env` | Verda API credentials, written by the owner |
| `clients.env` | `JEV_KEY_ORCHESTRATOR`, `JEV_KEY_APP`: 32 random bytes as hex each, made once, reused on every up |
| `state.json` | `{instanceId, hostname, ip, baseUrl, model, startedAt, status, …}`; The Orchestrator's host reads it (`status: "up"` + https) |
| `ledger.jsonl` | Append-only: one row per session `{at, instanceId, type, minutes, usd, note}` |
| `id_ed25519` | A per-session ssh key; `down` deletes it and its Verda record |

The other app gets `baseUrl` and `JEV_KEY_APP` as `JEV_BASE_URL` and
`JEV_API_KEY` in its server env. Its side is its own work, in its own repo.

## The cap (`policy.ts` capCheck)

`up` refuses when any of these holds:
- the ledger total plus a whole session (4 h × price) is over **$20**
- Verda's public price is more than 10% over the one we checked
- the balance, when readable, is below one whole session

Verda bills prepaid 10-minute blocks. The ledger charges `ceil(minutes/10)`
blocks and assumes no refund. A box nobody saw go is charged up to its 4 h
lifetime. On top of this, Verda discontinues everything at zero balance.

## The watchdog (`box/watchdog.sh`, every minute, systemd timer)

The watchdog runs on the box, so a crashed laptop cannot leave the box
running. The idle clock starts at whichever is latest: the last authenticated
request (the mtime of `/var/log/caddy/jev.log`), boot, or when setup finished.
After **15 idle minutes** the watchdog deletes the box. At **4 h** from boot it
deletes the box whatever the traffic. To delete, it gets a token and sends
`PUT /instances {action:"delete", id, volume_ids:[os volume], delete_permanently:true}`
for its own instance, and logs to `/var/log/jev-watchdog.log`. If the box is
still there, it tries again the next minute. `setup.sh` installs the watchdog
first. During setup the idle clock gets a 45-minute grace, so a slow GPU
install is not deleted halfway. `watchdog.test.ts` runs the script over a
table and checks that it agrees with `policy.ts` watchdogDecision.

## TLS and keys (`box/Caddyfile.tmpl`)

- The box answers at `https://<ip-with-dashes>.sslip.io`, with Caddy's
  automatic Let's Encrypt certificate.
- `GET /healthz` is open, answers 200 and is never logged.
- `/v1/*` needs `Authorization: Bearer <client key>`. Anything else gets 401,
  and that is not logged either, so a stranger cannot keep the box awake.
- Each authenticated call is logged as JSON with `client: orchestrator` or
  `client: app`.
- The keys reach Caddy through `/etc/caddy/jev.env` (0600, systemd
  `EnvironmentFile`), not the Caddyfile.
- ufw allows 22, 80 and 443 only.

Secrets never go in argv or the output. They travel in request bodies and
headers, and in a 0600 env file that the CLI copies to `/root/verda.env` with
scp and then deletes locally. The watchdog pipes them to curl on stdin.

## Serving

- **anyjev** (`anyjev-qwen3-8b`): AnyJev `[hf]` at commit `45add301`, with
  `Qwen/Qwen3-8B` in bf16 on the A6000. `box/anyjev_shim.py` (FastAPI and
  uvicorn on 127.0.0.1:8765) turns each System One `choice` question into an
  AnyJev `Question.choice` at level L0. It answers with the label and one
  probability per label, and the choice is always the argmax.
- **laya** (`laya-421m`): the Laya typed-decisions server on 127.0.0.1:8765,
  which speaks System One itself.

## UNVERIFIED (neither path has run on real hardware)

### The local launchd path (never run on the owner's Mac)

- **Every `install.sh` command.** `install`, `install --at-login`, `start`,
  `stop`, `status` and `uninstall` have never run. Only `render` writes
  nothing.
- **Whether `stop` stays stopped.** The plist sets `KeepAlive` with
  `SuccessfulExit=false`, so launchd restarts the server after any exit that
  is not clean. `stop` sends TERM. Whether the server then exits clean, and so
  stays stopped, is unknown.
- **The restart after a crash**, and its once-a-minute limit.
- **`GET /health`**, the 1.5 GB memory figure under launchd, and the 30% memory
  and 5 GB disk checks in `install`.
- **The watch-only step against a live local server.** `local.json` has never
  been written on this machine.

### The rented-box path (never run: no Verda account, no box)

- **`jev up`, `jev down` and `jev status` against Verda.** Only `dry-run` has
  run, and it uses canned answers with no network.
- **The idle watchdog deleting a real instance**, at 15 idle minutes or at 4 h.
- **Every install line in `box/setup.sh`.** That covers the apt packages, the
  Caddy apt repo, the AnyJev pip install, fastapi and uvicorn, and the
  systemd units.
- **The Laya server's pip package and command.** `laya-typed-decisions` and
  `laya-serve` are placeholders; set `LAYA_PIP` / `LAYA_SERVE` in the box env
  once known. Whether it serves `GET /healthz` is also unchecked.
- **The AnyJev calls in the shim** (`HFBackend`, `Decider`, `Question.choice`,
  `decide_batch(...)[0].probs`). They are copied from the upstream Jev
  project at the same commit, and never run behind FastAPI.
- **Caddy directives.** `log_skip` and `log_append` need a recent Caddy
  (2.8 or later). Also unchecked: whether the http→https redirect writes to
  `jev.log`. If it does, plain http hits reset the idle clock, and only the
  4 h lifetime bounds them.
- **Verda.** Which status a deleted instance reports (the CLI accepts a 404 or
  `discontinued`/`notfound`/`deleted`, and also requires the id to be gone
  from `GET /instances`). The exact `image_type` names (they need a token). The
  OS volume size and price (120 GB GPU, 40 GB CPU). How refunds show up.
- **Prices.** They come from the public `GET /v1/instance-types` on 28–29 Sep
  2026. `up` re-reads them every time and refuses a rise over 10%.
- **Time.** The model download and setup time on the A6000. Setup waits up to
  40 min for the model server, and the CLI up to 60 min for setup.
