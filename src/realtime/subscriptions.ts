import { createHash, timingSafeEqual } from "node:crypto";
import {
  loadSubscribeAuth,
  loadSubscriptionLimits,
  type SubscribeAuthConfig,
  type SubscriptionLimits,
} from "../config.js";
import { isQuerySafeValue } from "../tendermint-query.js";
import type { HistoryStore } from "../store/memory.js";
import type { WatchedWallet } from "../types.js";

/**
 * Platform wallets only. Every watched wallet costs two CometBFT websockets
 * (see CometWsDetector) plus one LCD poll per tick, so registration is a
 * resource grant: it is authenticated, counted per caller, capped globally and
 * released again when nobody reads the wallet.
 */

export type SubscriptionDenialReason =
  | "unauthenticated"
  | "subscribe_not_configured"
  | "caller_quota"
  | "registry_full"
  | "invalid_wallet";

export type SubscriptionOutcome =
  | { ok: true; created: boolean }
  | { ok: false; reason: SubscriptionDenialReason; message: string };

export class SubscriptionDeniedError extends Error {
  constructor(
    readonly reason: SubscriptionDenialReason,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionDeniedError";
  }
}

export interface SubscriberIdentity {
  /** Non-secret, stable id used for quota accounting and logs. */
  id: string;
  authenticated: boolean;
}

export const ANONYMOUS_SUBSCRIBER: SubscriberIdentity = {
  id: "anonymous",
  authenticated: false,
};

/**
 * Maps the subscribe headers onto a caller identity.
 * Throws when registration is gated and the caller did not present a valid
 * token — callers must surface the reason rather than degrade to anonymous.
 */
export function resolveSubscriber(
  headers: { token?: string | undefined; subject?: string | undefined },
  auth: SubscribeAuthConfig = loadSubscribeAuth(),
): SubscriberIdentity {
  const presented = headers.token?.trim();
  const match = presented
    ? auth.tokens.find((known) => constantTimeEquals(known, presented))
    : undefined;

  if (!match) {
    if (!auth.enforced) return ANONYMOUS_SUBSCRIBER;
    if (auth.tokens.length === 0) {
      throw new SubscriptionDeniedError(
        "subscribe_not_configured",
        "wallet subscription is disabled: this indexer has no INDEXER_SUBSCRIBE_TOKEN configured",
      );
    }
    throw new SubscriptionDeniedError(
      "unauthenticated",
      "wallet subscription requires a valid subscribe token",
    );
  }

  const tokenId = fingerprint(match);
  const subject = headers.subject?.trim();
  // The subject is opaque and caller-supplied, so it narrows the quota but can
  // never widen it: an unusable value falls back to the token's own bucket.
  const scoped =
    subject && isQuerySafeValue(subject)
      ? `${tokenId}:${fingerprint(subject)}`
      : tokenId;
  return { id: scoped, authenticated: true };
}

/** Stores that can release a wallet. Optional: the base HistoryStore cannot. */
type PrunableStore = HistoryStore & {
  deleteWallet?(chainId: string, address: string): Promise<void>;
};

export class SubscriptionRegistry {
  private readonly limits: SubscriptionLimits;
  /** callerId -> walletKey -> registration time. Per process; see ensure(). */
  private readonly registrations = new Map<string, Map<string, number>>();
  private lastSweepAt = 0;
  private warnedUnprunable = false;

  constructor(
    private readonly store: PrunableStore,
    limits: Partial<SubscriptionLimits> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = loadSubscriptionLimits(limits);
  }

  /**
   * Wallets the detectors should be watching: idle ones are dropped, rows whose
   * address could not be a query literal are dropped, and the result is capped
   * at maxWallets so a full registry cannot open unbounded sockets.
   */
  async list(): Promise<WatchedWallet[]> {
    const now = this.clock();
    await this.sweep(now);
    const wallets = await this.store.listWallets();
    return wallets
      .filter((w) => isWatchable(w))
      .filter((w) => !this.isIdle(w, now))
      .sort((a, b) => touchedAt(b) - touchedAt(a))
      .slice(0, this.limits.maxWallets);
  }

  /**
   * Registers or refreshes a wallet. Never throws: the read path calls this
   * before serving history and must not 500 because a cap was reached. Callers
   * that own the registration decision use register() instead.
   */
  async ensure(
    chainId: string,
    address: string,
    caller: SubscriberIdentity = ANONYMOUS_SUBSCRIBER,
  ): Promise<SubscriptionOutcome> {
    if (!isQuerySafeValue(address) || !isQuerySafeValue(chainId)) {
      return {
        ok: false,
        reason: "invalid_wallet",
        message: "chainId and address must be plain identifiers",
      };
    }

    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const existing = await this.store.getWallet(chainId, address);
    if (existing) {
      await this.store.upsertWallet({ ...existing, lastRefreshAt: nowIso });
      return { ok: true, created: false };
    }

    const quota = caller.authenticated
      ? this.limits.maxWalletsPerCaller
      : this.limits.maxWalletsPerAnonymousCaller;
    if (this.countRegistrations(caller.id, now) >= quota) {
      return {
        ok: false,
        reason: "caller_quota",
        message: `caller has reached its limit of ${quota} watched wallets`,
      };
    }

    await this.sweep(now);
    let watched = await this.store.listWallets();
    if (watched.length >= this.limits.maxWallets) {
      // At the cap, pay for a sweep now rather than refuse a wallet whose slot
      // is held by a row nobody has read in days.
      if ((await this.sweep(now, true)) > 0) {
        watched = await this.store.listWallets();
      }
    }
    if (watched.length >= this.limits.maxWallets) {
      return {
        ok: false,
        reason: "registry_full",
        message: `this indexer is watching its maximum of ${this.limits.maxWallets} wallets`,
      };
    }

    await this.store.upsertWallet({
      chainId,
      address,
      firstSeenAt: nowIso,
      lastRefreshAt: nowIso,
    });
    this.recordRegistration(caller.id, walletKey(chainId, address), now);
    return { ok: true, created: true };
  }

  /** ensure() for the authenticated subscribe endpoint: a denial is an error. */
  async register(
    chainId: string,
    address: string,
    caller: SubscriberIdentity,
  ): Promise<void> {
    const outcome = await this.ensure(chainId, address, caller);
    if (!outcome.ok) {
      throw new SubscriptionDeniedError(outcome.reason, outcome.message);
    }
  }

  /**
   * Drops wallets nobody has read within idleTtlMs. Durable release needs
   * HistoryStore.deleteWallet; without it list() still refuses to hand idle
   * wallets to the detectors, so no socket is held open for them.
   */
  async sweep(now: number = this.clock(), force = false): Promise<number> {
    if (!force && now - this.lastSweepAt < this.limits.evictionIntervalMs) {
      return 0;
    }
    this.lastSweepAt = now;
    this.pruneRegistrations(now);

    const remove = this.store.deleteWallet?.bind(this.store);
    if (!remove) {
      if (!this.warnedUnprunable) {
        this.warnedUnprunable = true;
        console.warn(
          "[realtime] store cannot delete wallets; idle rows are filtered out of the watch set but stay on disk",
        );
      }
      return 0;
    }

    const wallets = await this.store.listWallets();
    let evicted = 0;
    for (const wallet of wallets) {
      if (!this.isIdle(wallet, now) && isWatchable(wallet)) continue;
      await remove(wallet.chainId, wallet.address);
      evicted += 1;
    }
    return evicted;
  }

  private isIdle(wallet: WatchedWallet, now: number): boolean {
    return now - touchedAt(wallet) > this.limits.idleTtlMs;
  }

  private countRegistrations(callerId: string, now: number): number {
    const owned = this.registrations.get(callerId);
    if (!owned) return 0;
    for (const [key, at] of owned) {
      if (now - at > this.limits.idleTtlMs) owned.delete(key);
    }
    return owned.size;
  }

  private recordRegistration(callerId: string, key: string, now: number): void {
    const owned = this.registrations.get(callerId) ?? new Map<string, number>();
    owned.set(key, now);
    this.registrations.set(callerId, owned);
  }

  private pruneRegistrations(now: number): void {
    for (const [callerId, owned] of this.registrations) {
      for (const [key, at] of owned) {
        if (now - at > this.limits.idleTtlMs) owned.delete(key);
      }
      if (owned.size === 0) this.registrations.delete(callerId);
    }
  }
}

function walletKey(chainId: string, address: string): string {
  return `${chainId}::${address}`;
}

/** Legacy rows predate validation; a value that cannot be a query literal must
 *  never reach the detectors, whatever the HTTP boundary allowed at the time. */
function isWatchable(wallet: WatchedWallet): boolean {
  return isQuerySafeValue(wallet.address) && isQuerySafeValue(wallet.chainId);
}

function touchedAt(wallet: WatchedWallet): number {
  const raw = wallet.lastRefreshAt ?? wallet.firstSeenAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
