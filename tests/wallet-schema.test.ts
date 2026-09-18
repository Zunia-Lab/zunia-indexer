import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAddress, decodeBech32, isChainId } from "../src/address.ts";
import { DEFAULT_ADDRESS_POLICY } from "../src/config.ts";
import { createWalletBodySchema } from "../src/http/schemas.ts";

const COSMOS = "cosmos1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg3he2nj";
const OSMO = "osmo1qv9pzxqlyckngw6zf9g9whn9d3eh4qvgev269q";
const STARS = "stars1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg9twhcr";

const schema = createWalletBodySchema(DEFAULT_ADDRESS_POLICY);
const openSchema = createWalletBodySchema({
  ...DEFAULT_ADDRESS_POLICY,
  allowedPrefixes: "any",
});

test("accepts a served chain and its own address", () => {
  const parsed = schema.safeParse({ chainId: "cosmoshub-4", address: COSMOS });
  assert.equal(parsed.success, true);
});

test("rejects the injection payloads that widened the Tendermint query", () => {
  const payloads = [
    "x' OR message.action='/cosmos.bank.v1beta1.MsgSend",
    `${COSMOS}' OR tm.event='Tx`,
    `${COSMOS}'`,
    `${COSMOS}\n AND tm.event='Tx'`,
    "' OR '1'='1",
    "cosmos1' --",
  ];
  for (const address of payloads) {
    const parsed = schema.safeParse({ chainId: "cosmoshub-4", address });
    assert.equal(parsed.success, false, `expected rejection: ${address}`);
    const parsedOpen = openSchema.safeParse({ chainId: "cosmoshub-4", address });
    assert.equal(parsedOpen.success, false, `expected rejection: ${address}`);
  }
});

test("rejects a bech32 address whose checksum does not verify", () => {
  const flipped = `${COSMOS.slice(0, -1)}${COSMOS.endsWith("j") ? "k" : "j"}`;
  assert.equal(decodeBech32(flipped), undefined);
  const parsed = schema.safeParse({ chainId: "cosmoshub-4", address: flipped });
  assert.equal(parsed.success, false);
});

test("rejects an address that belongs to another chain", () => {
  const parsed = schema.safeParse({ chainId: "cosmoshub-4", address: OSMO });
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues[0]?.message ?? "",
    /does not belong to cosmoshub-4/,
  );
});

test("rejects a prefix the indexer does not serve, and says which it serves", () => {
  const parsed = schema.safeParse({ chainId: "stargaze-1", address: STARS });
  assert.equal(parsed.success, false);
  // Asserts the message names the served set, not one frozen list — adding a
  // chain to CHAIN_ADDRESS_PREFIXES is a config change, not a test failure.
  const message = parsed.error?.issues[0]?.message ?? "";
  assert.match(message, /address prefix is not served by this indexer \(serving: /);
  for (const hrp of ["addr_safro", "cosmos", "osmo", "akash", "noble"]) {
    assert.ok(message.includes(hrp), `message should name ${hrp}: ${message}`);
  }
  assert.equal(
    openSchema.safeParse({ chainId: "stargaze-1", address: STARS }).success,
    true,
  );
});

test("rejects a too-short payload that still carries a valid checksum", () => {
  // "cosmos1abc" style fixtures decode to fewer symbols than an account address.
  assert.equal(checkAddress("cosmos1abc", "cosmoshub-4", DEFAULT_ADDRESS_POLICY), "not_bech32");
});

test("rejects mixed case, which would key one wallet twice", () => {
  assert.equal(decodeBech32(COSMOS.toUpperCase()), undefined);
  assert.equal(schema.safeParse({ chainId: "cosmoshub-4", address: COSMOS.toUpperCase() }).success, false);
});

test("chainId accepts real chain ids and rejects query syntax", () => {
  for (const id of ["cosmoshub-4", "osmosis-1", "Neutaro-1", "kaiyo-1", "noble-1"]) {
    assert.equal(isChainId(id), true, id);
  }
  for (const id of ["cosmoshub-4' OR '1'='1", "chain id", "chain'", "", "-lead", "a".repeat(65)]) {
    assert.equal(isChainId(id), false, id);
  }
  assert.equal(
    schema.safeParse({ chainId: "cosmoshub-4' OR tm.event='Tx", address: COSMOS }).success,
    false,
  );
});

test("accepts the unusual but legal hrps real chains actually use", () => {
  // BIP-173 allows any US-ASCII 33-126 in the hrp. A narrower [a-z0-9]{2,16}
  // reads as reasonable and silently locks out Safrochain — this product's own
  // chain, whose prefix carries an underscore — along with Lava's "lava@" and
  // nyx's single-character "n". The checksum, not the charset, decides.
  const safro = "addr_safro1zlqc8hf3drqz9ntaklfhddetfay3tt9n9c2tar";
  assert.equal(decodeBech32(safro)?.prefix, "addr_safro");
  assert.equal(
    checkAddress(safro, "safrochain-1", DEFAULT_ADDRESS_POLICY),
    undefined,
  );
});
