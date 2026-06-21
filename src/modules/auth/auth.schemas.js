import { z } from 'zod';

const emailSchema = z.string().trim().email();
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters long.');

export const registerSchema = z.object({
  params: z.object({}).optional(),
  query: z.object({}).optional(),
  body: z.object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(120).optional()
  })
});

export const loginSchema = z.object({
  params: z.object({}).optional(),
  query: z.object({}).optional(),
  body: z.object({
    email: emailSchema,
    password: z.string().min(1)
  })
});
