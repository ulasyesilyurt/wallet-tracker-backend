import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const walletHoldingsParamsSchema = z.object({
  params: z.object({
    walletId: uuidSchema
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional()
});
