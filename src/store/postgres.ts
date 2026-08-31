import { drizzle } from "drizzle-orm/postgres-js";
import { and, desc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { HistoryStore } from "./memory.js";
import type { TxRecord, WatchedWallet } from "../types.js";

export const watchedWallets = pgTable(
  "watched_wallets",
  {
    chainId: text("chain_id").notNull(),
    address: text("address").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address] })],
);

export const txHistory = pgTable(
  "tx_history",
  {
    chainId: text("chain_id").notNull(),
    address: text("address").notNull(),
    txHash: text("tx_hash").notNull(),
    height: bigint("height", { mode: "number" }),
    timestamp: timestamp("timestamp", { withTimezone: true }),
    success: boolean("success").notNull().default(true),
    summary: text("summary").notNull().default(""),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address, t.txHash] })],
);

export function createPostgresStore(databaseUrl: string): HistoryStore & {
  close: () => Promise<void>;
} {
  const client = postgres(databaseUrl, { max: 5 });
  const db = drizzle(client);

  return {
    async getWallet(chainId, address) {
      const rows = await db
        .select()
        .from(watchedWallets)
        .where(
          and(
            eq(watchedWallets.chainId, chainId),
            eq(watchedWallets.address, address),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        chainId: row.chainId,
        address: row.address,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastRefreshAt: row.lastRefreshAt?.toISOString(),
      };
    },

    async upsertWallet(wallet: WatchedWallet) {
      await db
        .insert(watchedWallets)
        .values({
          chainId: wallet.chainId,
          address: wallet.address,
          firstSeenAt: new Date(wallet.firstSeenAt),
          lastRefreshAt: wallet.lastRefreshAt
            ? new Date(wallet.lastRefreshAt)
            : null,
        })
        .onConflictDoUpdate({
          target: [watchedWallets.chainId, watchedWallets.address],
          set: {
            lastRefreshAt: wallet.lastRefreshAt
              ? new Date(wallet.lastRefreshAt)
              : sql`${watchedWallets.lastRefreshAt}`,
          },
        });
    },

    async listWallets() {
      const rows = await db.select().from(watchedWallets);
      return rows.map((row) => ({
        chainId: row.chainId,
        address: row.address,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastRefreshAt: row.lastRefreshAt?.toISOString(),
      }));
    },

    async listTxs(chainId, address, limit) {
      const rows = await db
        .select()
        .from(txHistory)
        .where(
          and(eq(txHistory.chainId, chainId), eq(txHistory.address, address)),
        )
        .orderBy(desc(txHistory.timestamp), desc(txHistory.height))
        .limit(limit);
      return rows.map(rowToTx);
    },

    async upsertTxs(txs: TxRecord[]) {
      for (const tx of txs) {
        await db
          .insert(txHistory)
          .values({
            chainId: tx.chainId,
            address: tx.address,
            txHash: tx.txHash,
            height: tx.height ?? null,
            timestamp: tx.timestamp ? new Date(tx.timestamp) : null,
            success: tx.success,
            summary: tx.summary,
          })
          .onConflictDoUpdate({
            target: [txHistory.chainId, txHistory.address, txHistory.txHash],
            set: {
              height: tx.height ?? null,
              timestamp: tx.timestamp ? new Date(tx.timestamp) : null,
              success: tx.success,
              summary: tx.summary,
            },
          });
      }
    },

    async trim(chainId, address, max) {
      await db.execute(sql`
        DELETE FROM tx_history
        WHERE chain_id = ${chainId}
          AND address = ${address}
          AND tx_hash NOT IN (
            SELECT tx_hash FROM tx_history
            WHERE chain_id = ${chainId} AND address = ${address}
            ORDER BY timestamp DESC NULLS LAST, height DESC NULLS LAST
            LIMIT ${max}
          )
      `);
    },

    async hasTx(chainId, address, txHash) {
      const rows = await db
        .select({ txHash: txHistory.txHash })
        .from(txHistory)
        .where(
          and(
            eq(txHistory.chainId, chainId),
            eq(txHistory.address, address),
            eq(txHistory.txHash, txHash),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

function rowToTx(row: typeof txHistory.$inferSelect): TxRecord {
  return {
    chainId: row.chainId,
    address: row.address,
    txHash: row.txHash,
    height: row.height ?? undefined,
    timestamp: row.timestamp?.toISOString(),
    success: row.success,
    summary: row.summary,
  };
}
