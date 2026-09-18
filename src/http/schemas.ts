import { z } from "zod";
import {
  checkAddress,
  isChainId,
  type AddressPolicy,
  type AddressRejection,
} from "../address.js";
import { loadAddressPolicy } from "../config.js";

/**
 * The address reaches a Tendermint query literal and a store primary key, so it
 * is validated as a real bech32 address — checksum included — and refused
 * otherwise. The reason is returned to the caller: an address for a chain this
 * indexer does not serve is a different problem from a malformed one, and the
 * client cannot tell them apart from an empty history.
 */

export function createWalletBodySchema(policy: AddressPolicy) {
  return z
    .object({
      chainId: z
        .string()
        .min(1)
        .max(64)
        .refine(isChainId, "chainId must be alphanumeric with -, _ or ."),
      // Bounds are bech32's own: hrp + separator + 32 data symbols + checksum.
      address: z.string().min(8).max(90),
      forceRefresh: z.boolean().optional(),
    })
    .superRefine((body, ctx) => {
      const rejection = checkAddress(body.address, body.chainId, policy);
      if (!rejection) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: describe(rejection, body.chainId, policy),
      });
    });
}

export const walletBodySchema = createWalletBodySchema(loadAddressPolicy());

export type WalletBody = z.infer<typeof walletBodySchema>;

function describe(
  rejection: AddressRejection,
  chainId: string,
  policy: AddressPolicy,
): string {
  switch (rejection) {
    case "not_bech32":
      return "address must be a bech32 account address with a valid checksum";
    case "bad_length":
      return "address payload is not an account address length";
    case "prefix_not_served":
      return policy.allowedPrefixes === "any"
        ? "address prefix is not served by this indexer"
        : `address prefix is not served by this indexer (serving: ${policy.allowedPrefixes.join(", ")})`;
    case "prefix_chain_mismatch":
      return `address does not belong to ${chainId} (expected prefix ${policy.chainPrefixes[chainId]})`;
  }
}
