import { z } from 'zod';

export const emailSchema = z.string().trim().email();
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

export const googleSignInSchema = z.object({
  body: z.object({ idToken: z.string().min(1).max(16_384) }).strict()
});

export const appleSignInSchema = z.object({
  body: z.object({
    identityToken: z.string().min(1).max(16_384),
    expectedNonce: z.string().min(1).max(512)
  }).strict()
});

const codeSchema = z.string().regex(/^\d{6}$/, 'Code must contain exactly 6 digits.');

export const verifyEmailSchema = z.object({ body: z.object({ code: codeSchema }) });
export const forgotPasswordSchema = z.object({ body: z.object({ email: emailSchema }) });
export const resetPasswordSchema = z.object({
  body: z.object({ email: emailSchema, code: codeSchema, newPassword: passwordSchema })
});
