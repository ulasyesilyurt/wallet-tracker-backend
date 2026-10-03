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

const identityProviderSchema = z.enum(['google', 'apple']);
const currentPasswordProof = z.string().optional();

export const linkIdentitySchema = z.object({
  body: z.discriminatedUnion('provider', [
    z.object({
      provider: z.literal('google'),
      idToken: z.string().min(1).max(16_384),
      currentPassword: currentPasswordProof
    }).strict(),
    z.object({
      provider: z.literal('apple'),
      identityToken: z.string().min(1).max(16_384),
      expectedNonce: z.string().min(1).max(512),
      currentPassword: currentPasswordProof
    }).strict()
  ])
});

export const unlinkIdentitySchema = z.object({
  params: z.object({ provider: identityProviderSchema }),
  body: z.object({ currentPassword: currentPasswordProof }).strict()
});

const codeSchema = z.string().regex(/^\d{6}$/, 'Code must contain exactly 6 digits.');

export const verifyEmailSchema = z.object({ body: z.object({ code: codeSchema }) });
export const forgotPasswordSchema = z.object({ body: z.object({ email: emailSchema }) });
export const resetPasswordSchema = z.object({
  body: z.object({ email: emailSchema, code: codeSchema, newPassword: passwordSchema })
});

const deletionReauthMethod = z.enum(['password', 'apple', 'google']);
const deletionChallengeId = z.string().uuid();

export const accountDeletionReauthChallengeSchema = z.object({
  body: z.object({ method: deletionReauthMethod }).strict()
});

export const accountDeletionReauthVerifySchema = z.object({
  body: z.discriminatedUnion('method', [
    z.object({
      challengeId: deletionChallengeId,
      method: z.literal('password'),
      currentPassword: z.string().min(1).max(1024)
    }).strict(),
    z.object({
      challengeId: deletionChallengeId,
      method: z.literal('apple'),
      identityToken: z.string().min(1).max(16_384)
    }).strict(),
    z.object({
      challengeId: deletionChallengeId,
      method: z.literal('google')
    }).strict()
  ])
});

export const accountDeletionSchema = z.object({
  body: z.object({ deletionAuthorization: z.string().min(1).max(512) }).strict()
});
