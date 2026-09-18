import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTendermintQuery,
  isQuerySafeValue,
  quoteQueryValue,
  TendermintQueryError,
} from "../src/tendermint-query.ts";
import { fetchLcdTxs } from "../src/lcd/client.ts";
import { CometWsDetector } from "../src/realtime/ws.ts";
import type { TxDetectedEvent } from "../src/realtime/types.ts";
import type { WatchedWallet } from "../src/types.ts";

const ADDRESS = "cosmos1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg3he2nj";

/** Values that turn a per-wallet filter into something wider if interpolated. */
const INJECTION_PAYLOADS = [
  "x' OR message.action='/cosmos.bank.v1beta1.MsgSend",
  `${ADDRESS}' OR tm.event='Tx`,
  `${ADDRESS}' AND message.sender='${ADDRESS}`,
  "'",
  `${ADDRESS}'`,
  `${ADDRESS}\n AND tm.event='Tx'`,
  `${ADDRESS} OR 1=1`,
  `${ADDRESS}\\' OR '1'='1`,
  `${ADDRESS}" OR "1"="1`,
  "tm.event='Tx'",
  "",
  "a".repeat(129),
];

test("quoteQueryValue always returns a quoted literal", () => {
  assert.equal(quoteQueryValue(ADDRESS), `'${ADDRESS}'`);
  assert.equal(quoteQueryValue("Tx"), "'Tx'");
  assert.equal(quoteQueryValue("cosmoshub-4"), "'cosmoshub-4'");
});

test("quoteQueryValue rejects every injection payload", () => {
  for (const payload of INJECTION_PAYLOADS) {
    assert.equal(isQuerySafeValue(payload), false, `expected unsafe: ${payload}`);
    assert.throws(
      () => quoteQueryValue(payload),
      TendermintQueryError,
      `expected throw for: ${payload}`,
    );
  }
});

test("buildTendermintQuery owns the AND join and quotes every value", () => {
  const query = buildTendermintQuery([
    { key: "tm.event", value: "Tx" },
    { key: "transfer.recipient", value: ADDRESS },
  ]);
  assert.equal(query, `tm.event='Tx' AND transfer.recipient='${ADDRESS}'`);
});

test("buildTendermintQuery rejects a hostile key and an empty condition list", () => {
  assert.throws(
    () => buildTendermintQuery([{ key: "transfer.recipient' OR x", value: ADDRESS }]),
    TendermintQueryError,
  );
  assert.throws(() => buildTendermintQuery([]), TendermintQueryError);
});

test("fetchLcdTxs sends quoted recipient and sender queries", async () => {
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("query") ?? "");
    return new Response(JSON.stringify({ tx_responses: [] }), {
      headers: { "content-type": "application/json" },
    });
  };

  await fetchLcdTxs({
    rest: "https://lcd.test",
    chainId: "cosmoshub-4",
    address: ADDRESS,
    limit: 5,
    fetchImpl,
  });

  assert.deepEqual(queries, [
    `transfer.recipient='${ADDRESS}'`,
    `message.sender='${ADDRESS}'`,
  ]);
});

test("fetchLcdTxs refuses an injected address instead of calling the LCD", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };

  for (const payload of INJECTION_PAYLOADS) {
    await assert.rejects(
      fetchLcdTxs({
        rest: "https://lcd.test",
        chainId: "cosmoshub-4",
        address: payload,
        limit: 5,
        fetchImpl,
      }),
      TendermintQueryError,
    );
  }
  assert.equal(calls, 0);
});

test("CometWsDetector subscribes with a quoted per-wallet query", async () => {
  FakeSocket.reset();
  const detector = new CometWsDetector(
    walletSource([{ chainId: "cosmoshub-4", address: ADDRESS, firstSeenAt: NOW }]),
    NOOP_PUBLISHER,
    [{ chainId: "cosmoshub-4", rpc: "https://rpc.test" }],
    FakeSocket as unknown as typeof WebSocket,
  );

  await detector.reconcile();
  assert.equal(FakeSocket.instances.length, 2, "one socket per role");
  for (const socket of FakeSocket.instances) socket.emit("open");

  const sent = FakeSocket.instances.map((s) => queryOf(s.sent[0]));
  assert.deepEqual(sent.sort(), [
    `tm.event='Tx' AND message.sender='${ADDRESS}'`,
    `tm.event='Tx' AND transfer.recipient='${ADDRESS}'`,
  ]);
  detector.stop();
});

test("CometWsDetector opens no socket for a wallet that cannot be a literal", async () => {
  FakeSocket.reset();
  // A sample of the payloads above; the full set is covered by quoteQueryValue.
  const wallets: WatchedWallet[] = [
    "x' OR message.action='/cosmos.bank.v1beta1.MsgSend",
    `${ADDRESS}' OR tm.event='Tx`,
    `${ADDRESS}\n AND tm.event='Tx'`,
  ].map((address) => ({ chainId: "cosmoshub-4", address, firstSeenAt: NOW }));
  const detector = new CometWsDetector(
    walletSource(wallets),
    NOOP_PUBLISHER,
    [{ chainId: "cosmoshub-4", rpc: "https://rpc.test" }],
    FakeSocket as unknown as typeof WebSocket,
  );

  await detector.reconcile();
  assert.equal(FakeSocket.instances.length, 0);
  detector.stop();
});

const NOW = new Date().toISOString();

const NOOP_PUBLISHER = {
  async publish(_event: TxDetectedEvent) {
    /* detector output is covered in realtime.test.ts */
  },
};

function walletSource(wallets: WatchedWallet[]) {
  return {
    async list() {
      return wallets;
    },
  };
}

function queryOf(raw: string | undefined): string {
  const parsed = JSON.parse(raw ?? "{}") as { params?: { query?: string } };
  return parsed.params?.query ?? "";
}

/** Minimal WebSocket stand-in: records what the detector sends. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    /* nothing to release */
  }

  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}
