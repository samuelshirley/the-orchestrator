// The Headroom relay: what The Orchestrator's agents point ANTHROPIC_BASE_URL
// at (127.0.0.1:8791), never Headroom itself. Each request goes to Headroom
// (127.0.0.1:8792) while Headroom answers its health check, else straight to
// https://api.anthropic.com, so a Headroom crash, restart or stop costs at
// most the requests in flight to it. headroom.ts decides when the host
// starts and stops it; headroomrelay.test.ts pins this file.
//
// The rules:
//   - It decides per request from a health flag it refreshes itself every
//     HEALTH_POLL_MS (GET /health, HEALTH_TIMEOUT_MS). A reading older than
//     HEALTH_STALE_MS, or any failed connection to Headroom, means direct.
//   - A request Headroom refused to connect (ECONNREFUSED: it never saw it)
//     is sent again direct, once, with the bytes kept so far.
//   - Every header passes through unchanged (Authorization and OAuth too),
//     except hop-by-hop headers and Host. Bodies are piped, both ways, never
//     decoded or buffered: server-sent events stream as they come.
//   - It never logs bodies, headers or auth; only starts, upstream switches
//     and error codes.
//   - It is its own process (host.ts starts it detached, own process group,
//     pid file), so a plugin reload or host restart leaves it running.
//
// node runs this file directly (type stripping; the host copies it to
// relay.mts), so it has no relative imports and only erasable TypeScript;
// node:* is imported inside startRelay and the main block.

import type { IncomingMessage, ServerResponse, Server, ClientRequest, OutgoingHttpHeaders } from "node:http";

/** Bumped when the relay's behaviour changes: the host replaces an older relay once nothing is in flight. */
export const RELAY_VERSION = 1;
export const RELAY_FLAG = "--orchestrator-relay";
export const RELAY_HEALTH_PATH = "/__relay/health";
export const DIRECT_ORIGIN = "https://api.anthropic.com";
/** How often the relay asks Headroom for its health. */
export const HEALTH_POLL_MS = 3_000;
/** Headroom's /health answers within this or counts as down. */
export const HEALTH_TIMEOUT_MS = 1_000;
/** A health reading older than this is no reading: direct. */
export const HEALTH_STALE_MS = 10_000;
/** Request bytes kept for one direct retry after ECONNREFUSED; past this, no retry. */
export const RETRY_BODY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1, plus the proxy-* ones in use): they
 * describe one connection, not the request, so they never cross the relay.
 */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type Upstream = "headroom" | "direct";
export type HealthReading = { healthy: boolean; at: number };

/** Headroom while its last health reading is healthy and fresh; anything else goes direct. */
export function chooseUpstream(reading: HealthReading | null, now: number): Upstream {
  if (reading === null || !reading.healthy) return "direct";
  if (now - reading.at > HEALTH_STALE_MS || reading.at > now + HEALTH_POLL_MS) return "direct";
  return "headroom";
}

/** Headroom's GET /health: HTTP 200 with checks.startup.ready true (headroom.ts parseHealth reads the same). */
export function headroomHealthy(status: number | null, bodyText: string | null): boolean {
  if (status !== 200 || bodyText === null) return false;
  try {
    const body = JSON.parse(bodyText) as { checks?: { startup?: { ready?: unknown } } } | null;
    return body?.checks?.startup?.ready === true;
  } catch {
    return false;
  }
}

type HeaderValue = string | string[] | number | undefined;

/**
 * The headers to send on: every one as it came, minus hop-by-hop headers,
 * the ones Connection names, and Host (the upstream's own is set).
 */
export function forwardHeaders(headers: Readonly<Record<string, HeaderValue>>): Record<string, string | string[]> {
  const named = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection" || value === undefined) continue;
    for (const part of (Array.isArray(value) ? value.join(",") : String(value)).split(",")) {
      const token = part.trim().toLowerCase();
      if (token !== "") named.add(token);
    }
  }
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === "host" || HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out[name] = Array.isArray(value) ? value : String(value);
  }
  return out;
}

/** Only a connection Headroom refused is retried direct: Headroom never saw the request. */
export function retryDirect(args: { upstream: Upstream; code: string | undefined; responded: boolean; kept: boolean }): boolean {
  return args.upstream === "headroom" && args.code === "ECONNREFUSED" && !args.responded && args.kept;
}

export type RelayHealth = {
  ok: true;
  pid: number;
  version: number;
  upstream: Upstream;
  inFlight: number;
  startedAt: number;
};

export type RelayArgs = { host: string; port: number; headroomPort: number };

/** The relay's argv after the script path; `parseRelayArgs` reads it back. */
export function relayArgs({ host, port, headroomPort }: RelayArgs): string[] {
  return [RELAY_FLAG, "--host", host, "--port", String(port), "--headroom-port", String(headroomPort)];
}

export function parseRelayArgs(argv: readonly string[]): RelayArgs | null {
  if (!argv.includes(RELAY_FLAG)) return null;
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const port = Number(value("--port"));
  const headroomPort = Number(value("--headroom-port"));
  const host = value("--host");
  if (host !== "127.0.0.1") return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!Number.isInteger(headroomPort) || headroomPort < 1 || headroomPort > 65535 || headroomPort === port) return null;
  return { host, port, headroomPort };
}

// ------------------------------------------------------------------ server

export type RelayOptions = RelayArgs & {
  /** Where direct goes; tests point it at a local server. */
  direct?: { protocol: "http:" | "https:"; host: string; port: number };
  log?: (line: string) => void;
  now?: () => number;
};

export type RunningRelay = {
  server: Server;
  port: number;
  /** The current reading's choice, for tests and the health answer. */
  upstream: () => Upstream;
  inFlight: () => number;
  close: () => Promise<void>;
};

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const http = await import("node:http");
  const https = await import("node:https");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const direct = options.direct ?? { protocol: "https:" as const, host: new URL(DIRECT_ORIGIN).hostname, port: 443 };
  const startedAt = now();
  let reading: HealthReading | null = null;
  let last: Upstream | null = null;
  let inFlight = 0;

  const note = (upstream: Upstream) => {
    if (upstream !== last) log(`upstream: ${upstream}`);
    last = upstream;
  };

  const poll = () => {
    const request = http.request(
      { host: "127.0.0.1", port: options.headroomPort, path: "/health", method: "GET", timeout: HEALTH_TIMEOUT_MS },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (text.length < 100_000) text += chunk;
        });
        response.on("end", () => {
          reading = { healthy: headroomHealthy(response.statusCode ?? null, text), at: now() };
          note(chooseUpstream(reading, now()));
        });
        response.on("error", () => {
          reading = { healthy: false, at: now() };
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => {
      reading = { healthy: false, at: now() };
      note("direct");
    });
    request.end();
  };
  poll();
  const timer = setInterval(poll, HEALTH_POLL_MS);
  timer.unref();

  const open = (upstream: Upstream, req: IncomingMessage, onResponse: (response: IncomingMessage) => void): ClientRequest => {
    const headers = forwardHeaders(req.headers) as OutgoingHttpHeaders;
    const target =
      upstream === "headroom"
        ? { protocol: "http:" as const, host: "127.0.0.1", port: options.headroomPort }
        : direct;
    const lib = target.protocol === "https:" ? https : http;
    const outgoing = lib.request(
      { protocol: target.protocol, host: target.host, port: target.port, method: req.method, path: req.url, headers, servername: target.host },
      onResponse,
    );
    outgoing.on("socket", (socket) => socket.setNoDelay(true));
    return outgoing;
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === RELAY_HEALTH_PATH) {
      const body: RelayHealth = { ok: true, pid: process.pid, version: RELAY_VERSION, upstream: chooseUpstream(reading, now()), inFlight, startedAt };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    inFlight += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
    };
    res.on("close", finish);

    let upstream = chooseUpstream(reading, now());
    let responded = false;
    let kept: Buffer[] | null = [];
    let keptBytes = 0;
    let ended = false;
    let outgoing: ClientRequest;

    const onResponse = (response: IncomingMessage) => {
      responded = true;
      kept = null;
      res.writeHead(response.statusCode ?? 502, response.statusMessage ?? "", forwardHeaders(response.headers) as OutgoingHttpHeaders);
      res.flushHeaders();
      response.pipe(res);
      // Upstream gone mid-body (Headroom killed mid-stream): cut the client too, so it retries rather than waits.
      response.on("error", () => res.destroy());
      response.on("aborted", () => res.destroy());
    };

    const wire = (request: ClientRequest) => {
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (upstream === "headroom") {
          // Down until the next poll says otherwise: new requests go direct.
          reading = { healthy: false, at: now() };
          note("direct");
        }
        if (retryDirect({ upstream, code: error.code, responded, kept: kept !== null })) {
          log("headroom refused a request: sending it direct");
          upstream = "direct";
          outgoing = open("direct", req, onResponse);
          wire(outgoing);
          for (const chunk of kept ?? []) outgoing.write(chunk);
          if (ended) outgoing.end();
          // A pause waiting on the refused request's drain would never end.
          req.resume();
          return;
        }
        log(`request to ${upstream} failed: ${error.code ?? "error"}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `The Orchestrator's relay could not reach ${upstream === "headroom" ? "Headroom" : "Anthropic"} (${error.code ?? "error"}).` } }));
        } else {
          res.destroy();
        }
      });
    };

    outgoing = open(upstream, req, onResponse);
    wire(outgoing);
    req.on("data", (chunk: Buffer) => {
      if (kept !== null) {
        keptBytes += chunk.length;
        if (keptBytes > RETRY_BODY_MAX_BYTES) kept = null;
        else kept.push(chunk);
      }
      if (!outgoing.write(chunk)) {
        req.pause();
        outgoing.once("drain", () => req.resume());
      }
    });
    req.on("end", () => {
      ended = true;
      outgoing.end();
    });
    req.on("error", () => outgoing.destroy());
    res.on("close", () => {
      if (!res.writableFinished) outgoing.destroy();
    });
  };

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  log(`relay ${RELAY_VERSION} listening on ${options.host}:${port}, Headroom on ${options.headroomPort}`);
  return {
    server,
    port,
    upstream: () => chooseUpstream(reading, now()),
    inFlight: () => inFlight,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// -------------------------------------------------------------------- main

if ((import.meta as { main?: boolean }).main && process.argv.includes(RELAY_FLAG)) {
  // No top-level await: bb bundles this file into the host too, where neither holds.
  const args = parseRelayArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(`relay: usage: ${RELAY_FLAG} --host 127.0.0.1 --port N --headroom-port M\n`);
    process.exit(2);
  }
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  void startRelay({ ...args, log }).then(
    (relay) => {
      const stop = () => {
        // Stop taking requests; leave once the ones in flight are done (the host waits for none in flight first).
        relay.server.close();
        const wait = setInterval(() => {
          if (relay.inFlight() === 0) process.exit(0);
        }, 200);
        setTimeout(() => process.exit(0), 10_000).unref();
        wait.unref();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      process.on("SIGHUP", () => undefined);
    },
    (error: unknown) => {
      log(`relay: could not start: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
