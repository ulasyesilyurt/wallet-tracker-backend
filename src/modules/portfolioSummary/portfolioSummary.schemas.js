import { z } from 'zod';

const uuidSchema = z.string().uuid();
const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const walletPortfolioSummaryParamsSchema = z.object({
  params: z.object({
    walletId: uuidSchema
  }),
  body: z.object({}).optional(),
  query: z.object({
    includePositions: booleanQuerySchema
  }).optional()
});
