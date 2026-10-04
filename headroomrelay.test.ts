import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HEALTH_POLL_MS,
  HEALTH_STALE_MS,
  HOP_BY_HOP,
  RELAY_HEALTH_PATH,
  RELAY_VERSION,
  chooseUpstream,
  forwardHeaders,
  headroomHealthy,
  parseRelayArgs,
  retryDirect,
  startRelay,
  type RunningRelay,
} from "./headroomrelay";

const NOW = 1_800_000_000_000;

describe("chooseUpstream", () => {
  it("goes to Headroom only on a fresh healthy reading", () => {
    expect(chooseUpstream({ healthy: true, at: NOW - 1_000 }, NOW)).toBe("headroom");
    expect(chooseUpstream({ healthy: true, at: NOW - HEALTH_STALE_MS }, NOW)).toBe("headroom");
  });
  it("goes direct with no reading, an unhealthy one, a stale one, or one from the future", () => {
    expect(chooseUpstream(null, NOW)).toBe("direct");
    expect(chooseUpstream({ healthy: false, at: NOW }, NOW)).toBe("direct");
    expect(chooseUpstream({ healthy: true, at: NOW - HEALTH_STALE_MS - 1 }, NOW)).toBe("direct");
    expect(chooseUpstream({ healthy: true, at: NOW + HEALTH_POLL_MS + 1 }, NOW)).toBe("direct");
  });
});

describe("headroomHealthy", () => {
  it("is 200 with startup ready, nothing else", () => {
    expect(headroomHealthy(200, JSON.stringify({ checks: { startup: { ready: true } } }))).toBe(true);
    expect(headroomHealthy(200, JSON.stringify({ checks: { startup: { ready: false } } }))).toBe(false);
    expect(headroomHealthy(503, JSON.stringify({ checks: { startup: { ready: true } } }))).toBe(false);
    expect(headroomHealthy(200, "<html>")).toBe(false);
    expect(headroomHealthy(null, null)).toBe(false);
  });
});

describe("forwardHeaders", () => {
  it("passes every end-to-end header through unchanged, auth included", () => {
    const headers = {
      authorization: "Bearer sk-ant-oat01-secret",
      "x-api-key": "sk-ant-api-secret",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,prompt-caching",
      "content-type": "application/json",
      "content-length": "123",
      "accept-encoding": "gzip, br",
      "user-agent": "claude-cli/2.1",
      "set-cookie": ["a=1", "b=2"],
    };
    expect(forwardHeaders(headers)).toEqual(headers);
  });
  it("strips hop-by-hop headers, the ones Connection names, and Host", () => {
    const out = forwardHeaders({
      host: "127.0.0.1:8791",
      connection: "keep-alive, X-Hop",
      "keep-alive": "timeout=5",
      "proxy-authorization": "Basic x",
      "proxy-authenticate": "Basic",
      "proxy-connection": "keep-alive",
      te: "trailers",
      trailer: "x",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "x-hop": "1",
      authorization: "Bearer t",
    });
    expect(out).toEqual({ authorization: "Bearer t" });
    for (const name of HOP_BY_HOP) expect(forwardHeaders({ [name]: "x", a: "1" })).toEqual({ a: "1" });
  });
  it("strips nothing else", () => {
    // Mutation guard: a header that merely looks hop-ish survives.
    expect(forwardHeaders({ "x-connection-id": "1", "keep-alive-ms": "2", "x-forwarded-host": "h" })).toEqual({
      "x-connection-id": "1",
      "keep-alive-ms": "2",
      "x-forwarded-host": "h",
    });
  });
});

describe("retryDirect", () => {
  it("retries only what Headroom refused to connect, before any answer, with the body kept", () => {
    expect(retryDirect({ upstream: "headroom", code: "ECONNREFUSED", responded: false, kept: true })).toBe(true);
    expect(retryDirect({ upstream: "headroom", code: "ECONNRESET", responded: false, kept: true })).toBe(false);
    expect(retryDirect({ upstream: "headroom", code: "ECONNREFUSED", responded: true, kept: true })).toBe(false);
    expect(retryDirect({ upstream: "headroom", code: "ECONNREFUSED", responded: false, kept: false })).toBe(false);
    expect(retryDirect({ upstream: "direct", code: "ECONNREFUSED", responded: false, kept: true })).toBe(false);
  });
});

describe("parseRelayArgs", () => {
  it("takes 127.0.0.1 only, and two different ports", () => {
    expect(parseRelayArgs(["--orchestrator-relay", "--host", "127.0.0.1", "--port", "8791", "--headroom-port", "8792"])).toEqual({
      host: "127.0.0.1",
      port: 8791,
      headroomPort: 8792,
    });
    expect(parseRelayArgs(["--orchestrator-relay", "--host", "0.0.0.0", "--port", "8791", "--headroom-port", "8792"])).toBeNull();
    expect(parseRelayArgs(["--orchestrator-relay", "--host", "127.0.0.1", "--port", "8791", "--headroom-port", "8791"])).toBeNull();
    expect(parseRelayArgs(["--host", "127.0.0.1", "--port", "8791", "--headroom-port", "8792"])).toBeNull();
    expect(parseRelayArgs(["--orchestrator-relay", "--host", "127.0.0.1", "--port", "x", "--headroom-port", "8792"])).toBeNull();
  });
});

// ----------------------------------------------------------- the server
// In process, on free ports, against dummy upstreams: never 8791 or 8792,
// never Headroom or Anthropic.

const open: Array<{ close: () => unknown }> = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
  return { server, port: (server.address() as AddressInfo).port };
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const healthyHeadroom = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ checks: { startup: { ready: true } }, config: { pid: 1234 } }));
};

async function relayTo(headroomPort: number, directPort: number): Promise<RunningRelay> {
  const relay = await startRelay({ host: "127.0.0.1", port: 0, headroomPort, direct: { protocol: "http:", host: "127.0.0.1", port: directPort } });
  open.push(relay);
  return relay;
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("the relay server", () => {
  it("answers its own health check with its pid, version and what is in flight", async () => {
    const direct = await serve((_req, res) => res.end("direct"));
    const relay = await relayTo(await freePort(), direct.port);
    const health = await call(relay.port, RELAY_HEALTH_PATH);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, pid: process.pid, version: RELAY_VERSION, upstream: "direct", inFlight: 0 });
  });

  it("goes to Headroom while it is healthy", async () => {
    const seen: string[] = [];
    const headroom = await serve((req, res) => {
      if (req.url === "/health") return healthyHeadroom(res);
      seen.push(`headroom ${req.method} ${req.url}`);
      res.end("via headroom");
    });
    const direct = await serve((_req, res) => res.end("direct"));
    const relay = await relayTo(headroom.port, direct.port);
    await until(() => relay.upstream() === "headroom");
    const reply = await call(relay.port, "/v1/messages?beta=true", { method: "POST", body: "{}" });
    expect(reply.body).toBe("via headroom");
    expect(seen).toEqual(["headroom POST /v1/messages?beta=true"]);
  });

  it("goes direct when Headroom is down, and passes the request through unchanged", async () => {
    let got: { url: string | undefined; headers: IncomingMessage["headers"]; body: string } | null = null;
    const direct = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        got = { url: req.url, headers: req.headers, body };
        res.writeHead(201, { "x-upstream": "direct", connection: "keep-alive", "keep-alive": "timeout=5" });
        res.end("ok");
      });
    });
    const relay = await relayTo(await freePort(), direct.port);
    const reply = await call(relay.port, "/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json", "proxy-authorization": "x", te: "trailers" },
      body: '{"model":"m"}',
    });
    expect(reply.status).toBe(201);
    expect(reply.headers["x-upstream"]).toBe("direct");
    // The relay's own connection has its own keep-alive; the upstream's never crosses.
    expect(reply.headers["keep-alive"]).not.toBe("timeout=5");
    expect(got).not.toBeNull();
    const seen = got as unknown as { url: string; headers: IncomingMessage["headers"]; body: string };
    expect(seen.url).toBe("/v1/messages");
    expect(seen.body).toBe('{"model":"m"}');
    expect(seen.headers.authorization).toBe("Bearer oauth-token");
    expect(seen.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
    expect(seen.headers.te).toBeUndefined();
    expect(seen.headers.host).toBe(`127.0.0.1:${direct.port}`);
  });

  it("streams server-sent events as they come, never buffered", async () => {
    let gotFirst: () => void = () => undefined;
    const firstArrived = new Promise<void>((resolve) => (gotFirst = resolve));
    const direct = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: message_start\ndata: {}\n\n");
      // The second event waits until the client has the first: a relay that
      // buffers would never deliver it, and the test would time out.
      void firstArrived.then(() => res.end("event: message_stop\ndata: {}\n\n"));
    });
    const relay = await relayTo(await freePort(), direct.port);
    const chunks: string[] = await new Promise((resolve, reject) => {
      const seen: string[] = [];
      const req = request({ host: "127.0.0.1", port: relay.port, path: "/v1/messages", method: "POST" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          seen.push(chunk);
          if (seen.length === 1) gotFirst();
        });
        res.on("end", () => resolve(seen));
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(chunks[0]).toBe("event: message_start\ndata: {}\n\n");
    expect(chunks.join("")).toContain("message_stop");
  }, 5_000);

  it("sends a request Headroom refused straight to Anthropic, body and all, and goes direct after", async () => {
    let headroomUp = true;
    const headroom = await serve((req, res) => {
      if (req.url === "/health" && headroomUp) return healthyHeadroom(res);
      res.statusCode = 500;
      res.end();
    });
    const bodies: string[] = [];
    const direct = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        bodies.push(body);
        res.end("direct");
      });
    });
    const relay = await relayTo(headroom.port, direct.port);
    await until(() => relay.upstream() === "headroom");
    // Headroom stops: its port refuses connections before the next poll.
    headroomUp = false;
    headroom.server.closeAllConnections();
    await new Promise<void>((resolve) => headroom.server.close(() => resolve()));
    const big = "x".repeat(200_000);
    const reply = await call(relay.port, "/v1/messages", { method: "POST", body: big });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("direct");
    expect(bodies).toEqual([big]);
    expect(relay.upstream()).toBe("direct");
  });

  it("answers 502 when the upstream cannot be reached, and counts nothing in flight after", async () => {
    const relay = await relayTo(await freePort(), await freePort());
    const reply = await call(relay.port, "/v1/messages", { method: "POST", body: "{}" });
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toMatchObject({ type: "error", error: { type: "api_error" } });
    await until(() => relay.inFlight() === 0);
  });
});
