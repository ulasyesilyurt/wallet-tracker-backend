import { z } from 'zod';

const alchemyAddressSchema = z.string().min(1);

const hexOrDecimalStringSchema = z.string().min(1);

const alchemyLogSchema = z.object({
  address: alchemyAddressSchema.optional(),
  blockNumber: hexOrDecimalStringSchema.optional(),
  data: z.string().optional(),
  logIndex: hexOrDecimalStringSchema.optional(),
  transactionHash: z.string().optional(),
  topics: z.array(z.string()).default([])
}).passthrough();

const alchemyRawContractSchema = z.object({
  address: alchemyAddressSchema.optional(),
  decimals: z.union([z.number(), z.string()]).optional(),
  rawValue: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional()
}).passthrough();

const alchemyErc1155MetadataSchema = z.object({
  tokenId: z.string(),
  value: z.union([z.string(), z.number()]).optional()
}).passthrough();

const alchemyActivitySchema = z.object({
  blockNum: hexOrDecimalStringSchema.optional(),
  hash: z.string().min(1),
  fromAddress: alchemyAddressSchema,
  toAddress: alchemyAddressSchema.nullish(),
  category: z.string().min(1),
  asset: z.string().nullish(),
  value: z.union([z.string(), z.number()]).nullish(),
  erc721TokenId: z.string().nullish(),
  erc1155Metadata: z.array(alchemyErc1155MetadataSchema).nullish(),
  rawContract: alchemyRawContractSchema.nullish(),
  log: alchemyLogSchema.nullish()
}).passthrough();

export const alchemyWebhookSchema = z.object({
  params: z.object({}).default({}),
  query: z.object({}).default({}),
  body: z.object({
    webhookId: z.string().min(1).optional(),
    id: z.string().optional(),
    createdAt: z.string().optional(),
    type: z.string().min(1).optional(),
    event: z.object({
      network: z.string().min(1).optional(),
      activity: z.array(alchemyActivitySchema).default([])
    }).passthrough()
  }).passthrough()
});
