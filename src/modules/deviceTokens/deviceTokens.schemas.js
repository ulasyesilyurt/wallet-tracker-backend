import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const createDeviceTokenSchema = z.object({
  params: z.object({
    userId: uuidSchema
  }),
  body: z.object({
    token: z.string().trim().min(1).max(4096),
    platform: z.enum(['ios', 'android'])
  }),
  query: z.object({}).optional()
});

export const deleteDeviceTokenSchema = z.object({
  params: z.object({
    userId: uuidSchema
  }),
  body: z.object({
    token: z.string().trim().min(1).max(4096)
  }),
  query: z.object({}).optional()
});
