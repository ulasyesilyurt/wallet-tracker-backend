import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const walletPerformanceParamsSchema = z.object({
  params: z.object({
    walletId: uuidSchema
  }),
  query: z.object({}).default({}),
  body: z.object({}).default({})
});

export const portfolioPerformanceSchema = z.object({
  params: z.object({}).default({}),
  query: z.object({}).default({}),
  body: z.object({}).default({})
});
