import { z } from "zod";

export const walletBodySchema = z.object({
  chainId: z.string().min(1).max(128),
  address: z.string().min(1).max(128),
  forceRefresh: z.boolean().optional(),
});

export type WalletBody = z.infer<typeof walletBodySchema>;
