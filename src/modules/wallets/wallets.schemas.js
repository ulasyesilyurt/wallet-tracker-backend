import { z } from 'zod';
import { SUPPORTED_CHAIN_IDS } from '../chains/chains.config.js';
import { EDITABLE_WALLET_TRACK_TYPES, WALLET_TRACK_TYPES } from './wallets.constants.js';

const uuidSchema = z.string().uuid();

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const chainIdSchema = z.enum(SUPPORTED_CHAIN_IDS);
const enabledChainsSchema = z.array(chainIdSchema).min(1).max(SUPPORTED_CHAIN_IDS.length);

function normalizeEnabledChains(enabledChains, chainId) {
  const values = [
    ...(Array.isArray(enabledChains) ? enabledChains : []),
    ...(chainId ? [chainId] : [])
  ];

  return [...new Set(values)];
}

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
    chainId: chainIdSchema.optional(),
    enabledChains: enabledChainsSchema.optional(),
    address: z.string().regex(addressPattern, 'Wallet address must be a valid EVM address'),
    label: z.string().trim().min(1).max(100).optional(),
    trackTypes: z.array(z.enum(WALLET_TRACK_TYPES)).min(1).max(4)
  }).refine((value) => value.chainId !== undefined || value.enabledChains !== undefined, {
    message: 'At least one chain must be provided',
    path: ['enabledChains']
  }).transform((value) => {
    const normalizedEnabledChains = normalizeEnabledChains(value.enabledChains, value.chainId);
    const primaryChainId = value.chainId ?? normalizedEnabledChains[0];

    return {
      ...value,
      chainId: primaryChainId,
      enabledChains: normalizedEnabledChains
    };
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

export const walletAlertSettingsParamsSchema = z.object({
  params: z.object({
    walletId: uuidSchema
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional()
});

export const putWalletAlertSettingsSchema = z.object({
  params: z.object({
    walletId: uuidSchema
  }),
  body: z.object({
    minimumAlertUsd: z.number().min(0).nullable(),
    notificationsEnabled: z.boolean(),
    notifyNftTransfers: z.boolean()
  }),
  query: z.object({}).optional()
});

export const updateWalletSchema = z.object({
  params: z.object({
    userId: uuidSchema,
    walletId: uuidSchema
  }),
  body: z.object({
    address: z.string().regex(addressPattern, 'Wallet address must be a valid EVM address').optional(),
    chainId: chainIdSchema.optional(),
    enabledChains: enabledChainsSchema.optional(),
    label: z.string().trim().min(1).max(100).optional(),
    trackTypes: z.array(z.enum(EDITABLE_WALLET_TRACK_TYPES)).min(1).max(3).optional()
  }).transform((value) => {
    if (value.chainId === undefined && value.enabledChains === undefined) {
      return value;
    }

    return {
      ...value,
      enabledChains: normalizeEnabledChains(value.enabledChains, value.chainId)
    };
  }).refine((value) => (
    value.address !== undefined ||
    value.label !== undefined ||
    value.trackTypes !== undefined ||
    value.enabledChains !== undefined
  ), {
    message: 'At least one field must be provided',
    path: []
  }),
  query: z.object({}).optional()
});
