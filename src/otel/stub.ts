/**
 * OpenTelemetry stub middleware — no SDK dependency yet.
 * Swap console spans for @opentelemetry/api when OTEL_EXPORTER_* is configured.
 */

import { createMiddleware } from "hono/factory";

export type SpanStub = {
  name: string;
  start: number;
  attrs: Record<string, string | number | boolean>;
  end: (status?: "ok" | "error") => void;
};

export function startSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
): SpanStub {
  const start = Date.now();
  return {
    name,
    start,
    attrs,
    end(status = "ok") {
      if (process.env.OTEL_STUB_LOG === "true") {
        console.info(
          JSON.stringify({
            otel_stub: true,
            span: name,
            status,
            durationMs: Date.now() - start,
            ...attrs,
          }),
        );
      }
    },
  };
}

export function otelStubMiddleware() {
  return createMiddleware(async (c, next) => {
    const span = startSpan("http.request", {
      method: c.req.method,
      path: c.req.path,
    });
    try {
      await next();
      span.attrs["http.status"] = c.res.status;
      span.end(c.res.status >= 500 ? "error" : "ok");
    } catch (err) {
      span.end("error");
      throw err;
    }
  });
}
