import { createMiddleware } from "hono/factory";

/** Simple in-memory sliding window — fine for single worker; use Redis later for multi-instance */
export function rateLimit(options: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return createMiddleware(async (c, next) => {
    const key =
      c.req.header("x-api-key") ??
      c.req.header("x-forwarded-for") ??
      "anon";
    const now = Date.now();
    const windowStart = now - options.windowMs;
    const prev = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (prev.length >= options.max) {
      return c.json({ error: "rate_limited" }, 429);
    }
    prev.push(now);
    hits.set(key, prev);
    await next();
  });
}

export function requireApiKey(expected: string | undefined) {
  return createMiddleware(async (c, next) => {
    if (!expected) {
      await next();
      return;
    }
    const key = c.req.header("x-api-key");
    if (key !== expected) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}
