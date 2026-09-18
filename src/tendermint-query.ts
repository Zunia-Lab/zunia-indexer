/**
 * Builder for the CometBFT / Tendermint query grammar used by both the LCD tx
 * search (`/cosmos/tx/v1beta1/txs?query=`) and the WS `subscribe` method.
 *
 * The grammar has no parameter binding and its single-quoted string literals
 * have no escape sequence, so a value containing a quote cannot be represented
 * at all — escaping it would be a guess. Values are therefore refused when they
 * fall outside a conservative character set, and no export returns a bare
 * value: a caller cannot concatenate an operand itself.
 */

const CHARSET_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const CHARSET_KEY = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const MAX_VALUE_LENGTH = 128;
const MAX_KEY_LENGTH = 64;

export class TendermintQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TendermintQueryError";
  }
}

export interface QueryCondition {
  /** Event attribute, e.g. "transfer.recipient" */
  key: string;
  /** Compared as a quoted string literal */
  value: string;
}

/**
 * True when the value can be carried inside a quoted literal without changing
 * the shape of the query. Excludes quotes, whitespace, comparison operators and
 * the AND/OR separators, so no value can terminate its literal or add a clause.
 */
export function isQuerySafeValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    CHARSET_VALUE.test(value)
  );
}

/** Quoted string literal, or a throw. Never returns an unquoted value. */
export function quoteQueryValue(value: string): string {
  if (!isQuerySafeValue(value)) {
    throw new TendermintQueryError(
      `value is not representable as a query literal: ${preview(value)}`,
    );
  }
  return `'${value}'`;
}

/** Conditions joined with AND. The join is owned here, never by a caller. */
export function buildTendermintQuery(conditions: QueryCondition[]): string {
  if (conditions.length === 0) {
    throw new TendermintQueryError("a query needs at least one condition");
  }
  return conditions
    .map((c) => `${assertQueryKey(c.key)}=${quoteQueryValue(c.value)}`)
    .join(" AND ");
}

function assertQueryKey(key: string): string {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !CHARSET_KEY.test(key)) {
    throw new TendermintQueryError(`not an event attribute key: ${preview(key)}`);
  }
  return key;
}

/** Truncated and JSON-quoted so a rejected value cannot forge a log line. */
function preview(value: string): string {
  const head = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(head);
}
