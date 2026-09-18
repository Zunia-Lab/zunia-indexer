/**
 * Validation for the two caller-supplied identifiers the indexer accepts:
 * a bech32 account address and a chain id. Both reach a Tendermint query and a
 * store key, so they are rejected rather than repaired — a value that is not a
 * bech32 address is not a typo, and there is no correct way to guess what the
 * caller meant.
 *
 * bech32 (BIP-173) is decoded here rather than pulled in as a dependency: the
 * checksum is 30 lines and the indexer has no other use for the package.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;

/** Cosmos chain ids are alphanumeric with -, _ or . (e.g. cosmoshub-4, Neutaro-1). */
const CHAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AddressPolicy {
  /** Accepted human-readable parts, or "any" to accept every valid bech32 hrp. */
  allowedPrefixes: readonly string[] | "any";
  /** chainId -> hrp for chains whose prefix is known; others are not cross-checked. */
  chainPrefixes: Readonly<Record<string, string>>;
  /** 5-bit data symbols excluding the checksum. 32 = a 20-byte account. */
  minDataLength: number;
  maxDataLength: number;
}

export type AddressRejection =
  | "not_bech32"
  | "bad_length"
  | "prefix_not_served"
  | "prefix_chain_mismatch";

export interface Bech32Address {
  prefix: string;
  /** Number of 5-bit data symbols, checksum excluded. */
  dataLength: number;
}

/** Decodes and verifies the bech32 checksum. Undefined means "not an address". */
export function decodeBech32(input: string): Bech32Address | undefined {
  // BIP-173 caps the whole string at 90; cosmos addresses are lowercase only,
  // and accepting the uppercase form would let one wallet arrive under two keys.
  if (input.length < 8 || input.length > 90) return undefined;
  if (input !== input.toLowerCase()) return undefined;

  const separator = input.lastIndexOf("1");
  if (separator < 1 || separator + 7 > input.length) return undefined;

  const prefix = input.slice(0, separator);
  // BIP-173 allows any US-ASCII 33-126 in the hrp, 1-83 characters. Narrowing
  // that to [a-z0-9]{2,16} locks out real chains: Safrochain's own prefix is
  // "addr_safro", Lava's is "lava@", and nyx's is the single character "n".
  // Uppercase is already excluded by the lowercase check above, and the
  // checksum below is what actually decides whether this is an address.
  if (!/^[\x21-\x7e]{1,83}$/.test(prefix)) return undefined;

  const symbols: number[] = [];
  for (const char of input.slice(separator + 1)) {
    const value = CHARSET.indexOf(char);
    if (value === -1) return undefined;
    symbols.push(value);
  }

  if (polymod([...expandPrefix(prefix), ...symbols]) !== BECH32_CONST) {
    return undefined;
  }
  return { prefix, dataLength: symbols.length - 6 };
}

/** Undefined when the address is acceptable; otherwise why it was refused. */
export function checkAddress(
  address: string,
  chainId: string,
  policy: AddressPolicy,
): AddressRejection | undefined {
  const decoded = decodeBech32(address);
  if (!decoded) return "not_bech32";
  if (
    decoded.dataLength < policy.minDataLength ||
    decoded.dataLength > policy.maxDataLength
  ) {
    return "bad_length";
  }
  if (
    policy.allowedPrefixes !== "any" &&
    !policy.allowedPrefixes.includes(decoded.prefix)
  ) {
    return "prefix_not_served";
  }
  const expected = policy.chainPrefixes[chainId];
  if (expected !== undefined && expected !== decoded.prefix) {
    return "prefix_chain_mismatch";
  }
  return undefined;
}

export function isChainId(value: string): boolean {
  return CHAIN_ID_PATTERN.test(value);
}

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < GENERATOR.length; i += 1) {
      if (((top >>> i) & 1) !== 0) chk ^= GENERATOR[i] ?? 0;
    }
  }
  return chk;
}

function expandPrefix(prefix: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of prefix) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}
