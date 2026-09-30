// node jev/cli.ts up|down|status|dry-run
//
// Rents one Verda box in Helsinki that serves a Jev-compatible typed-decision
// model behind Caddy TLS, with a key per client (The Orchestrator,
// a second client app). The box deletes ITSELF after 15 idle minutes or 4 hours
// (jev/box/watchdog.sh); `down` deletes it from here. The rules are in
// policy.ts; this file is the I/O, all of it behind `Deps` so dry-run and the
// tests never touch the network or the real ~/.config/jev.
//
// Secrets (Verda credentials, client keys, the API token) go only in request
// bodies, headers and 0600 files, never in argv or the output. Exit codes:
// 0 ok | 2 usage | 3 credentials missing | 4 delete not confirmed |
// 5 no capacity in Helsinki | 6 refused (no model, cap, price, already up) |
// 7 failed after create (the box was torn down).
import {
  CAP_USD,
  CLIENTS,
  FAILED_STATUSES,
  IDLE_MINUTES,
  MAX_LIFETIME_HOURS,
  MAX_SESSION_HOURS,
  VERDA_VARS,
  baseUrlFor,
  capCheck,
  clientKeyVar,
  hostnameFor,
  idFromBody,
  isClientKey,
  isGone,
  ledgerLine,
  ledgerTotal,
  missingVars,
  modelFromConfig,
  parseEnv,
  parseLedger,
  pickImage,
  pickLocation,
  priceOf,
  renderEnv,
  sessionCostUsd,
  settleMinutes,
  usd,
} from "./policy.ts";

export const API = "https://api.verda.com/v1";
const UA = "jev-cli/1.0 (the-orchestrator)";
const BOX_FILES = ["setup.sh", "watchdog.sh", "Caddyfile.tmpl", "anyjev_shim.py"] as const;
const OS_VOLUME_GB = { gpu: 120, cpu: 40 } as const;

export interface HttpResponse {
  status: number;
  text: string;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the CLI does to the world. */
export interface Deps {
  http(method: string, url: string, opts: { headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<HttpResponse>;
  exec(cmd: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  readFile(path: string): string | null;
  /** Creates the parent directory 0700 if needed; the file gets `mode`. */
  writeFile(path: string, content: string, mode: number): void;
  appendFile(path: string, content: string, mode: number): void;
  removeFile(path: string): void;
  configDir: string;
  boxDir: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  randomHex(bytes: number): string;
}

export interface JevState {
  status: "up" | "down" | "starting";
  instanceId: string | null;
  hostname: string | null;
  ip: string | null;
  baseUrl: string | null;
  model: string | null;
  startedAt: string | null;
  instanceType?: string | null;
  priceUsdH?: number | null;
  sshKeyId?: string | null;
}

class Fail extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const paths = (deps: Deps) => ({
  config: `${deps.configDir}/config.json`,
  verda: `${deps.configDir}/verda.env`,
  clients: `${deps.configDir}/clients.env`,
  state: `${deps.configDir}/state.json`,
  ledger: `${deps.configDir}/ledger.jsonl`,
  key: `${deps.configDir}/id_ed25519`,
  knownHosts: `${deps.configDir}/known_hosts`,
  boxEnv: `${deps.configDir}/box.env`,
});

function readState(deps: Deps): JevState | null {
  const raw = deps.readFile(paths(deps).state);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as JevState;
  } catch {
    return null;
  }
}

function writeState(deps: Deps, state: JevState) {
  deps.writeFile(paths(deps).state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A Verda error's own code, never its whole body. */
function errorCode(text: string): string {
  const body = json(text);
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : "";
}

// ------------------------------------------------------------------ Verda

class Verda {
  deps: Deps;
  creds: Record<string, string>;
  token: string | null = null;
  tokenExpires = 0;

  constructor(deps: Deps, creds: Record<string, string>) {
    this.deps = deps;
    this.creds = creds;
  }

  async ensureToken() {
    if (this.token !== null && this.deps.now() < this.tokenExpires - 300_000) return this.token;
    const body = JSON.stringify({
      grant_type: "client_credentials",
      client_id: this.creds.VERDA_CLIENT_ID,
      client_secret: this.creds.VERDA_CLIENT_SECRET,
    });
    const response = await this.deps.http("POST", `${API}/oauth2/token`, {
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body,
      timeoutMs: 30_000,
    });
    this.deps.out(`  POST /oauth2/token -> ${response.status}`);
    const parsed = json(response.text) as { access_token?: unknown; expires_in?: unknown } | null;
    if (response.status !== 200 || typeof parsed?.access_token !== "string") {
      throw new Fail(3, `Verda refused the credentials in ${paths(this.deps).verda}: HTTP ${response.status}${errorCode(response.text)}.`);
    }
    this.token = parsed.access_token;
    this.tokenExpires = this.deps.now() + (Number(parsed.expires_in) || 3600) * 1000;
    return this.token;
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
    const token = await this.ensureToken();
    const response = await this.deps.http(method, `${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": UA,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 60_000,
    });
    this.deps.out(`  ${method} ${path} -> ${response.status}${response.status >= 400 ? errorCode(response.text) : ""}`);
    return { status: response.status, body: json(response.text), text: response.text };
  }
}

async function publicPrice(deps: Deps, instanceType: string): Promise<number | null> {
  const response = await deps.http("GET", `${API}/instance-types?currency=usd`, { headers: { "User-Agent": UA }, timeoutMs: 30_000 });
  deps.out(`  GET /instance-types -> ${response.status}`);
  return response.status === 200 ? priceOf(json(response.text), instanceType) : null;
}

function readCreds(deps: Deps): Record<string, string> {
  const env = parseEnv(deps.readFile(paths(deps).verda));
  const missing = missingVars(env, VERDA_VARS);
  if (missing.length > 0) {
    throw new Fail(3, `Missing ${missing.join(", ")} in ${paths(deps).verda} (the owner writes that file; see jev/README.md).`);
  }
  return env;
}

/** The two client keys, made once and reused on every up. */
function clientKeys(deps: Deps): Record<string, string> {
  const file = paths(deps).clients;
  const env = parseEnv(deps.readFile(file));
  let changed = false;
  for (const client of CLIENTS) {
    const name = clientKeyVar(client);
    if (!isClientKey(env[name])) {
      env[name] = deps.randomHex(32);
      changed = true;
    }
  }
  if (changed) {
    deps.writeFile(file, renderEnv(env), 0o600);
    deps.out(`Client keys written to ${file} (0600).`);
  }
  return env;
}

// ------------------------------------------------------------------ ssh

function sshOpts(deps: Deps): string[] {
  const p = paths(deps);
  return [
    "-i", p.key,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${p.knownHosts}`,
    "-o", "ConnectTimeout=15",
    "-o", "BatchMode=yes",
    "-o", "LogLevel=ERROR",
  ];
}

async function ssh(deps: Deps, ip: string, command: string, timeoutMs: number) {
  return deps.exec("ssh", [...sshOpts(deps), `root@${ip}`, command], { timeoutMs });
}

async function waitFor<T>(deps: Deps, what: string, limitMs: number, everyMs: number, probe: () => Promise<T | null>): Promise<T> {
  const until = deps.now() + limitMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (deps.now() >= until) throw new Fail(7, `Timed out waiting for ${what}.`);
    await deps.sleep(everyMs);
  }
}

// ------------------------------------------------------------------ up

export async function up(deps: Deps): Promise<number> {
  const p = paths(deps);
  const picked = modelFromConfig(deps.readFile(p.config));
  if (!picked.ok) throw new Fail(6, picked.reason);
  const { model, profile } = picked;
  const creds = readCreds(deps);
  const prior = readState(deps);
  if (prior !== null && prior.status !== "down") {
    throw new Fail(6, `The last box (${prior.hostname ?? prior.instanceId ?? "?"}) is still recorded as ${prior.status}. Run \`node jev/cli.ts down\` first; it settles the ledger.`);
  }

  deps.out(`Model ${model}: ${profile.instanceType} (${profile.server}).`);
  const price = await publicPrice(deps, profile.instanceType);
  const verda = new Verda(deps, creds);
  const balance = await verda.call("GET", "/balance");
  const amount = Number((balance.body as { amount?: unknown } | null)?.amount);
  const balanceUsd = balance.status === 200 && Number.isFinite(amount) ? amount : null;
  const ledgerUsd = ledgerTotal(parseLedger(deps.readFile(p.ledger)));
  const cap = capCheck({
    ledgerUsd,
    priceUsdH: price ?? Number.NaN,
    expectedUsdH: profile.expectedUsdH,
    maxSessionHours: MAX_SESSION_HOURS,
    balanceUsd,
  });
  if (!cap.ok) throw new Fail(6, cap.reason);
  const priceUsdH = price as number;
  deps.out(`Cap ok: $${usd(ledgerUsd)} spent of $${CAP_USD}; this session at most $${usd(priceUsdH * MAX_SESSION_HOURS)}; balance ${balanceUsd === null ? "unknown" : `$${usd(balanceUsd)}`}.`);

  const keys = clientKeys(deps);
  const availability = await verda.call("GET", "/instance-availability?is_spot=false");
  const location = pickLocation(availability.body, profile.instanceType);
  if (location === null) throw new Fail(5, `No ${profile.instanceType} free in Helsinki (FIN-01/02/03) right now.`);
  const images = await verda.call("GET", `/images?instance_type=${encodeURIComponent(profile.instanceType)}`);
  const image = pickImage(images.body, profile.gpu);
  if (image === null) throw new Fail(6, `No suitable Ubuntu image for ${profile.instanceType}.`);

  deps.removeFile(p.key);
  deps.removeFile(`${p.key}.pub`);
  deps.removeFile(p.knownHosts);
  const keygen = await deps.exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", "jev", "-f", p.key], { timeoutMs: 30_000 });
  const pub = deps.readFile(`${p.key}.pub`);
  if (keygen.code !== 0 || pub === null) throw new Fail(6, "ssh-keygen failed.");
  const hostname = hostnameFor(new Date(deps.now()));
  const added = await verda.call("POST", "/ssh-keys", { name: hostname, key: pub.trim() });
  const sshKeyId = idFromBody(added.body);
  if (sshKeyId === null) throw new Fail(6, `Verda did not take the ssh key (HTTP ${added.status}).`);

  const state: JevState = {
    status: "starting",
    instanceId: null,
    hostname,
    ip: null,
    baseUrl: null,
    model,
    startedAt: new Date(deps.now()).toISOString(),
    instanceType: profile.instanceType,
    priceUsdH,
    sshKeyId,
  };
  writeState(deps, state);

  try {
    const created = await verda.call("POST", "/instances", {
      instance_type: profile.instanceType,
      image,
      hostname,
      location_code: location,
      ssh_key_ids: [sshKeyId],
      description: "Jev typed-decision server (the-orchestrator jev/cli.ts)",
      is_spot: false,
      contract: "PAY_AS_YOU_GO",
      os_volume: { name: `${hostname}-os`, size: profile.gpu ? OS_VOLUME_GB.gpu : OS_VOLUME_GB.cpu },
    });
    if (created.status === 503) throw new Fail(5, `Verda has no ${profile.instanceType} capacity in ${location} (503).`);
    const instanceId = idFromBody(created.body);
    if (instanceId === null) throw new Fail(7, `Create answered HTTP ${created.status} without an id.`);
    state.instanceId = instanceId;
    writeState(deps, state);
    deps.out(`Created ${instanceId} (${hostname}) in ${location}; waiting for it to run.`);

    const ip = await waitFor(deps, "the instance to run", 30 * 60_000, 20_000, async () => {
      const got = await verda.call("GET", `/instances/${instanceId}`);
      const info = got.body as { status?: unknown; ip?: unknown } | null;
      const status = typeof info?.status === "string" ? info.status : null;
      if (status !== null && FAILED_STATUSES.has(status)) throw new Fail(7, `The instance went ${status}.`);
      return status === "running" && typeof info?.ip === "string" && info.ip !== "" ? info.ip : null;
    });
    const osVolumeId = await osVolumeOf(verda, instanceId);
    const baseUrl = baseUrlFor(ip);
    Object.assign(state, { ip, baseUrl });
    writeState(deps, state);

    await waitFor(deps, "ssh", 10 * 60_000, 15_000, async () => ((await ssh(deps, ip, "true", 30_000)).code === 0 ? true : null));
    deps.writeFile(
      p.boxEnv,
      renderEnv({
        JEV_SERVER: profile.server,
        JEV_MODEL: model,
        JEV_HOST: baseUrl.replace(/^https:\/\//, ""),
        ...Object.fromEntries(CLIENTS.map((client) => [clientKeyVar(client), keys[clientKeyVar(client)]])),
        VERDA_CLIENT_ID: creds.VERDA_CLIENT_ID,
        VERDA_CLIENT_SECRET: creds.VERDA_CLIENT_SECRET,
        INSTANCE_ID: instanceId,
        OS_VOLUME_ID: osVolumeId ?? "",
        IDLE_MINUTES: String(IDLE_MINUTES),
        MAX_LIFETIME_HOURS: String(MAX_LIFETIME_HOURS),
      }),
      0o600,
    );
    try {
      await step(deps, "mkdir", ssh(deps, ip, "mkdir -p /root/jev", 60_000));
      await step(deps, "copy box files", deps.exec("scp", [...sshOpts(deps), ...BOX_FILES.map((f) => `${deps.boxDir}/${f}`), `root@${ip}:/root/jev/`], { timeoutMs: 120_000 }));
      await step(deps, "copy env", deps.exec("scp", [...sshOpts(deps), p.boxEnv, `root@${ip}:/root/verda.env`], { timeoutMs: 60_000 }));
    } finally {
      deps.removeFile(p.boxEnv);
    }
    deps.out("Running setup on the box (the watchdog goes in first).");
    await step(deps, "setup.sh", ssh(deps, ip, "bash /root/jev/setup.sh", 60 * 60_000));
    await waitFor(deps, `${baseUrl}/healthz`, 15 * 60_000, 15_000, async () => {
      const probe = await deps.http("GET", `${baseUrl}/healthz`, { timeoutMs: 5_000 }).catch(() => null);
      return probe?.status === 200 ? true : null;
    });
    state.status = "up";
    writeState(deps, state);
  } catch (error) {
    deps.out(`Failed: ${error instanceof Error ? error.message : String(error)}. Tearing down.`);
    const gone = await teardown(deps, verda, "failed during up");
    if (!gone) throw new Fail(4, unconfirmed(state.instanceId));
    throw new Fail(error instanceof Fail && error.code === 5 ? 5 : 7, "Nothing is left running after the failure above.");
  }
  deps.out("");
  deps.out(`Jev is up: ${state.baseUrl}`);
  deps.out(`  ${model} on ${profile.instanceType}, $${usd(priceUsdH)}/h.`);
  deps.out(`  Keys for The Orchestrator and the other app are in ${p.clients}.`);
  deps.out(`  The box deletes itself after ${IDLE_MINUTES} idle minutes or ${MAX_LIFETIME_HOURS} h. \`node jev/cli.ts down\` deletes it now.`);
  return 0;
}

async function step(deps: Deps, what: string, run: Promise<ExecResult>) {
  const result = await run;
  if (result.code !== 0) throw new Fail(7, `${what} failed (exit ${result.code}).`);
}

async function osVolumeOf(verda: Verda, instanceId: string): Promise<string | null> {
  const got = await verda.call("GET", `/instances/${instanceId}`);
  const id = (got.body as { os_volume_id?: unknown } | null)?.os_volume_id;
  return typeof id === "string" && id !== "" ? id : null;
}

const unconfirmed = (id: string | null) =>
  `!!! COULD NOT CONFIRM THE DELETE of ${id ?? "the jev- instance"}. Delete it at console.verda.com NOW: it bills until it is deleted. !!!`;

// ------------------------------------------------------------------ down

export async function down(deps: Deps): Promise<number> {
  const creds = readCreds(deps);
  const verda = new Verda(deps, creds);
  const gone = await teardown(deps, verda, "jev down");
  if (!gone) throw new Fail(4, unconfirmed(readState(deps)?.instanceId ?? null));
  deps.out("Jev is down.");
  return 0;
}

/**
 * Delete the recorded box (else any jev-* box), poll until Verda confirms it
 * gone, write the ledger row, drop the ssh key. True when nothing is left.
 */
async function teardown(deps: Deps, verda: Verda, why: string): Promise<boolean> {
  const p = paths(deps);
  const state = readState(deps);
  let ids: string[] = state?.instanceId ? [state.instanceId] : [];
  if (ids.length === 0) {
    const list = await verda.call("GET", "/instances");
    const rows = Array.isArray(list.body) ? (list.body as { id?: unknown; hostname?: unknown }[]) : [];
    // A create whose answer was lost still left a jev-* box; every jev-* box is ours.
    ids = rows
      .filter((row) => typeof row.hostname === "string" && row.hostname.startsWith("jev-"))
      .map((row) => String(row.id));
  }
  let allGone = true;
  for (const id of ids) {
    const volume = await osVolumeOf(verda, id).catch(() => null);
    const del = () =>
      verda.call("PUT", "/instances", { action: "delete", id, ...(volume !== null ? { volume_ids: [volume] } : {}), delete_permanently: true });
    await del();
    const until = deps.now() + 10 * 60_000;
    let polls = 0;
    let gone = false;
    for (;;) {
      const got = await verda.call("GET", `/instances/${id}`);
      const status = (got.body as { status?: unknown } | null)?.status;
      if (isGone(typeof status === "string" ? status : null, got.status)) {
        const list = await verda.call("GET", "/instances");
        const listed = Array.isArray(list.body) && (list.body as { id?: unknown }[]).some((row) => row.id === id);
        if (list.status === 200 && !listed) {
          gone = true;
          break;
        }
      }
      if (deps.now() >= until) break;
      await deps.sleep(20_000);
      polls += 1;
      if (polls % 3 === 0) await del();
    }
    const minutes = state?.startedAt ? settleMinutes(Date.parse(state.startedAt), deps.now()) : 0;
    const price = state?.priceUsdH ?? 0;
    const usdSpent = sessionCostUsd(minutes, price);
    deps.appendFile(
      p.ledger,
      ledgerLine({
        at: new Date(deps.now()).toISOString(),
        instanceId: id,
        type: state?.instanceType ?? "?",
        minutes,
        usd: usdSpent,
        note: `${why}; ${gone ? "deleted" : "DELETE UNCONFIRMED"}; ${Math.ceil(minutes / 10)} x 10-min blocks at $${usd(price)}/h, no refund assumed`,
      }),
      0o600,
    );
    deps.out(`${id}: ${gone ? "deleted" : "NOT confirmed deleted"} (~${minutes} min, $${usdSpent.toFixed(4)} to the ledger).`);
    allGone &&= gone;
  }
  if (state?.sshKeyId) await verda.call("DELETE", `/ssh-keys/${state.sshKeyId}`).catch(() => null);
  deps.removeFile(p.key);
  deps.removeFile(`${p.key}.pub`);
  deps.removeFile(p.knownHosts);
  if (state !== null) writeState(deps, { ...state, status: allGone ? "down" : state.status });
  return allGone;
}

// ------------------------------------------------------------------ status

export async function status(deps: Deps): Promise<number> {
  const p = paths(deps);
  const state = readState(deps);
  const spent = ledgerTotal(parseLedger(deps.readFile(p.ledger)));
  const picked = modelFromConfig(deps.readFile(p.config));
  deps.out(`Model: ${picked.ok ? picked.model : picked.reason}`);
  deps.out(`State: ${state === null ? "never up" : `${state.status} ${state.hostname ?? ""} ${state.baseUrl ?? ""}`.trim()}`);
  deps.out(`Spent: $${usd(spent)} of the $${CAP_USD} cap (ledger).`);
  const env = parseEnv(deps.readFile(p.verda));
  if (missingVars(env, VERDA_VARS).length === 0) {
    try {
      const verda = new Verda(deps, env);
      const balance = await verda.call("GET", "/balance");
      const amount = (balance.body as { amount?: unknown } | null)?.amount;
      deps.out(`Verda balance: ${typeof amount === "number" ? `$${usd(amount)}` : "unknown"}.`);
      if (state?.instanceId) {
        const got = await verda.call("GET", `/instances/${state.instanceId}`);
        const s = (got.body as { status?: unknown } | null)?.status;
        deps.out(`Instance ${state.instanceId}: ${got.status === 404 ? "gone" : typeof s === "string" ? s : `HTTP ${got.status}`}.`);
      }
    } catch (error) {
      deps.out(`Verda: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    deps.out(`Verda: no credentials in ${p.verda}; skipping balance and instance.`);
  }
  if (state?.baseUrl) {
    const probe = await deps.http("GET", `${state.baseUrl}/healthz`, { timeoutMs: 2_000 }).catch(() => null);
    deps.out(`Health: ${probe === null ? "no answer in 2 s" : `HTTP ${probe.status}`}.`);
  }
  return 0;
}

// ------------------------------------------------------------------ dry-run

const DRY_SECRET = "dry-run-secret-never-printed";

/** Fake deps: an in-memory ~/.config/jev, canned Verda answers, a clock that jumps on sleep. */
export function dryRunDeps(out: (line: string) => void, seed: Record<string, string> | null = null) {
  const files = new Map<string, string>();
  const configDir = "/dry-run/.config/jev";
  const initial = seed ?? {
    "config.json": '{"model":"anyjev-qwen3-8b"}\n',
    "verda.env": `VERDA_CLIENT_ID=dry-client\nVERDA_CLIENT_SECRET=${DRY_SECRET}\n`,
  };
  for (const [name, content] of Object.entries(initial)) files.set(`${configDir}/${name}`, content);
  let clock = Date.UTC(2026, 8, 29, 12, 0);
  let deleted = false;
  let deletePolls = 0;
  const calls: { method: string; url: string; body?: string }[] = [];
  const argv: string[][] = [];
  const instance = "00000000-dry0-4000-8000-0000000inst1";
  const canned = (method: string, url: string): HttpResponse => {
    const path = url.replace(API, "").replace(/\?.*$/, "");
    const ok = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
    if (url.endsWith("/healthz")) return { status: 200, text: "ok" };
    switch (`${method} ${path.startsWith("/instances/") ? "/instances/:id" : path.startsWith("/ssh-keys/") ? "/ssh-keys/:id" : path}`) {
      case "POST /oauth2/token":
        return ok({ access_token: "dry-token", expires_in: 3600 });
      case "GET /instance-types":
        return ok([{ instance_type: "1A6000.10V", price_per_hour: "0.6400" }, { instance_type: "CPU.4V.16G", price_per_hour: "0.04800" }]);
      case "GET /balance":
        return ok({ amount: 20, currency: "usd" });
      case "GET /instance-availability":
        return ok([{ location_code: "FIN-02", availabilities: ["1A6000.10V", "CPU.4V.16G"] }]);
      case "GET /images":
        return ok([{ image_type: "24.04.cuda12.9" }, { image_type: "ubuntu-24.04" }]);
      case "POST /ssh-keys":
        return ok("00000000-dry0-4000-8000-00000000ssh1", 201);
      case "DELETE /ssh-keys/:id":
        return { status: 200, text: "" };
      case "POST /instances":
        deleted = false;
        deletePolls = 0;
        return ok(instance, 202);
      case "PUT /instances":
        deleted = true;
        return ok([{ instanceId: instance, action: "delete", status: "success" }], 202);
      case "GET /instances":
        return ok(deleted ? [] : [{ id: instance, hostname: "jev-0929-1200" }]);
      case "GET /instances/:id":
        if (deleted) return (deletePolls += 1) < 2 ? ok({ id: instance, status: "deleting" }) : ok({ code: "not_found" }, 404);
        return ok({ id: instance, status: "running", ip: "203.0.113.10", os_volume_id: "00000000-dry0-4000-8000-00000000vol1" });
      default:
        return ok({ code: "dry_run_unknown" }, 400);
    }
  };
  const deps: Deps = {
    async http(method, url, opts) {
      calls.push({ method, url, body: opts.body });
      return canned(method, url);
    },
    async exec(cmd, args) {
      argv.push([cmd, ...args]);
      out(`  [exec] ${cmd} ${args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(-2).join(" ")}`);
      if (cmd === "ssh-keygen") files.set(`${args[args.indexOf("-f") + 1]}.pub`, "ssh-ed25519 AAAAdryrun jev\n");
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => void files.set(path, content),
    appendFile: (path, content) => void files.set(path, (files.get(path) ?? "") + content),
    removeFile: (path) => void files.delete(path),
    configDir,
    boxDir: "jev/box",
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    out,
    randomHex: (bytes) => "d".repeat(bytes * 2),
  };
  return { deps, files, calls, argv, secrets: [DRY_SECRET, "dry-token", "d".repeat(64)] };
}

export async function dryRun(out: (line: string) => void): Promise<number> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    out(`[dry-run] ${line}`);
  };
  const fake = dryRunDeps(say);
  say("up (canned Verda answers; no network, no real ~/.config/jev)");
  const upCode = await run(["up"], fake.deps);
  say("down");
  const downCode = await run(["down"], fake.deps);
  const leaked = fake.secrets.filter((secret) => fake.argv.some((a) => a.join(" ").includes(secret)) || lines.some((l) => l.includes(secret)));
  if (leaked.length > 0) {
    say(`FAIL: a secret reached argv or the output.`);
    return 1;
  }
  say(`ledger: ${fake.files.get(`${fake.deps.configDir}/ledger.jsonl`)?.trim() ?? "(none)"}`);
  say(`up exit ${upCode}, down exit ${downCode}; no secret in argv or output.`);
  return upCode === 0 && downCode === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ main

export async function run(args: readonly string[], deps: Deps): Promise<number> {
  try {
    switch (args[0]) {
      case "up":
        return await up(deps);
      case "down":
        return await down(deps);
      case "status":
        return await status(deps);
      case "dry-run":
        return await dryRun(deps.out);
      default:
        deps.out("usage: node jev/cli.ts up|down|status|dry-run");
        return 2;
    }
  } catch (error) {
    if (error instanceof Fail) {
      deps.out(error.message);
      return error.code;
    }
    deps.out(`Unexpected: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function realDeps(): Promise<Deps> {
  const fs = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const { randomBytes } = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");
  const ensureDir = (path: string) => fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return {
    async http(method, url, opts) {
      const response = await fetch(url, {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      return { status: response.status, text: await response.text() };
    },
    exec(cmd, args, opts) {
      return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: opts?.timeoutMs });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", () => resolve({ code: 127, stdout, stderr }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
    readFile: (path) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null),
    writeFile(path, content, mode) {
      ensureDir(path);
      fs.writeFileSync(path, content, { mode });
      fs.chmodSync(path, mode);
    },
    appendFile(path, content, mode) {
      ensureDir(path);
      fs.appendFileSync(path, content, { mode });
    },
    removeFile: (path) => fs.rmSync(path, { force: true }),
    configDir: join(homedir(), ".config", "jev"),
    boxDir: join(dirname(fileURLToPath(import.meta.url)), "box"),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (line) => console.log(line),
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

const invoked = process.argv[1] !== undefined && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) {
  const args = process.argv.slice(2);
  const deps =
    args[0] === "dry-run"
      ? ({ out: (line: string) => console.log(line) } as Deps)
      : await realDeps();
  process.exitCode = await run(args, deps);
}
