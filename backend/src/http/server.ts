/**
 * HTTP server — Fastify instance exposing two endpoints:
 *
 *  GET /healthz  — liveness probe; returns { status: "ok", uptime } with 200.
 *                  Returns { status: "error", reason } with 503 if the DB or
 *                  chain client reports unhealthy (reserved for future checks).
 *
 *  GET /metrics  — Prometheus text exposition; returns prom-client default
 *                  registry output with Content-Type text/plain;version=0.0.4.
 *
 * The server is started and stopped by main.ts as part of the graceful
 * lifecycle (fastify.listen → fastify.close on SIGTERM/SIGINT).
 *
 * Logging: Fastify's built-in request logging is disabled (logger:false) —
 * the application pino logger is used for all structured output instead,
 * avoiding duplicate log lines and double-serialisation.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { register as promRegister }      from "prom-client";
import type { AppConfig }                from "../config/schema.js";
import type { Logger }                   from "../logger.js";

// ─── createHttpServer ─────────────────────────────────────────────────────────

/**
 * Create and configure the Fastify HTTP server.
 *
 * Does NOT call fastify.listen() — the caller (main.ts) is responsible for
 * starting and stopping the server so it participates in graceful shutdown.
 *
 * @param config  Validated AppConfig — reads HTTP_PORT and HTTP_HOST.
 * @param logger  Application logger — used for server-level lifecycle events.
 * @returns       Configured FastifyInstance ready to be started with .listen().
 */
export function createHttpServer(config: AppConfig, logger: Logger): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // ── GET /healthz ───────────────────────────────────────────────────────────

  fastify.get("/healthz", async (_req, reply) => {
    reply.status(200).send({
      status:  "ok",
      service: "airclaim-oracle-backend",
      uptime:  Math.floor(process.uptime()),
    });
  });

  // ── GET /metrics ───────────────────────────────────────────────────────────

  fastify.get("/metrics", async (_req, reply) => {
    try {
      const metrics = await promRegister.metrics();
      reply
        .status(200)
        .header("Content-Type", promRegister.contentType)
        .send(metrics);
    } catch (err) {
      logger.error({ err }, "Failed to collect Prometheus metrics");
      reply.status(500).send("metrics collection error");
    }
  });

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  fastify.addHook("onError", async (_req, _reply, err) => {
    logger.error({ err }, "Fastify request error");
  });

  return fastify;
}
