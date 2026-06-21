import { z } from 'zod';
import { SUPPORTED_CHAIN_IDS } from '../chains/chains.config.js';
import { EDITABLE_WALLET_TRACK_TYPES, WALLET_TRACK_TYPES } from './wallets.constants.js';

const uuidSchema = z.string().uuid();

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const chainIdSchema = z.enum(SUPPORTED_CHAIN_IDS);

export const userParamsSchema = z.object({
  params: z.object({
    userId: uuidSchema
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional()
});

export const createWalletSchema = z.object({
  params: z.object({
    userId: uuidSchema
  }),
  body: z.object({
    chainId: chainIdSchema,
    address: z.string().regex(addressPattern, 'Wallet address must be a valid EVM address'),
    label: z.string().trim().min(1).max(100).optional(),
    trackTypes: z.array(z.enum(WALLET_TRACK_TYPES)).min(1).max(4)
  }),
  query: z.object({}).optional()
});

export const deleteWalletSchema = z.object({
  params: z.object({
    userId: uuidSchema,
    walletId: uuidSchema
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional()
});

export const updateWalletSchema = z.object({
  params: z.object({
    userId: uuidSchema,
    walletId: uuidSchema
  }),
  body: z.object({
    address: z.string().regex(addressPattern, 'Wallet address must be a valid EVM address').optional(),
    label: z.string().trim().min(1).max(100).optional(),
    trackTypes: z.array(z.enum(EDITABLE_WALLET_TRACK_TYPES)).min(1).max(3).optional()
  }).refine((value) => value.address !== undefined || value.label !== undefined || value.trackTypes !== undefined, {
    message: 'At least one field must be provided',
    path: []
  }),
  query: z.object({}).optional()
});
