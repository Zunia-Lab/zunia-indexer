import type { WakeUpNotification } from "./types.js";

/**
 * Delivery of wake-ups to zunia-backend's POST /internal/tx-events, which
 * turns each one into pushes for the devices watching the wallet. Both run on
 * the same host: BACKEND_EVENTS_URL is a 127.0.0.1 address, never the public
 * hostname, where the backend refuses these calls.
 */

/** Header carrying BACKEND_EVENTS_TOKEN; zunia-backend reads it as INTERNAL_EVENTS_TOKEN. */
export const BACKEND_EVENTS_TOKEN_HEADER = "x-zunia-internal-token";

export interface BackendEventsConfig {
  url: string;
  token: string;
  /** Per attempt. */
  timeoutMs: number;
  /** Attempts in all, the first included. */
  attempts: number;
  /** Wait before the second attempt; doubled for each one after. */
  backoffMs: number;
}

/** From BACKEND_EVENTS_URL and BACKEND_EVENTS_TOKEN; undefined unless both are set. */
export function loadBackendEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackendEventsConfig | undefined {
  const url = env.BACKEND_EVENTS_URL?.trim();
  const token = env.BACKEND_EVENTS_TOKEN?.trim();
  if (!url || !token) return undefined;
  return { url, token, timeoutMs: 5_000, attempts: 3, backoffMs: 500 };
}

type Attempt = "delivered" | "retry" | "final";

/** Remembered deliveries; the oldest is forgotten past this. */
const MAX_REMEMBERED = 50_000;

/**
 * Delivers each wallet's transaction once. A timeout, a network error, a 429
 * or a 5xx is retried with backoff; any other refusal is final. Never throws:
 * the consumer keeps caching history whatever the backend does.
 */
export class BackendEventsNotifier {
  private readonly delivered = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: BackendEventsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** The NotifyWakeUp hook. */
  readonly notify = async (wakeUp: WakeUpNotification): Promise<void> => {
    const key = `${wakeUp.chainId}:${wakeUp.address}:${wakeUp.txHash}`;
    if (this.delivered.has(key) || this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      for (let attempt = 1; attempt <= this.config.attempts; attempt += 1) {
        const outcome = await this.post(wakeUp);
        if (outcome === "delivered") {
          this.remember(key);
          return;
        }
        if (outcome === "final") return;
        if (attempt < this.config.attempts) {
          await this.sleep(this.config.backoffMs * 2 ** (attempt - 1));
        }
      }
      // The address stays out of logs, as it stays out of pushes.
      this.log(
        `[backend-events] ${wakeUp.chainId} ${wakeUp.txHash}: not delivered after ${this.config.attempts} attempts`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  };

  private async post(wakeUp: WakeUpNotification): Promise<Attempt> {
    try {
      const res = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [BACKEND_EVENTS_TOKEN_HEADER]: this.config.token,
        },
        body: JSON.stringify({
          chainId: wakeUp.chainId,
          address: wakeUp.address,
          txHash: wakeUp.txHash,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.ok) return "delivered";
      if (res.status === 408 || res.status === 429 || res.status >= 500) return "retry";
      this.log(`[backend-events] ${wakeUp.chainId} ${wakeUp.txHash}: refused with ${res.status}`);
      return "final";
    } catch {
      return "retry";
    }
  }

  private remember(key: string): void {
    this.delivered.add(key);
    if (this.delivered.size > MAX_REMEMBERED) {
      const oldest = this.delivered.values().next().value;
      if (oldest !== undefined) this.delivered.delete(oldest);
    }
  }
}
