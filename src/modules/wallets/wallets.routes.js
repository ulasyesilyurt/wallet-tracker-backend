import { Router } from 'express';
import { deleteWallet, getWallets, addWallet, patchWallet } from './wallets.controller.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { createWalletSchema, deleteWalletSchema, updateWalletSchema, userParamsSchema } from './wallets.schemas.js';

const router = Router();

router.post('/users/:userId/wallets', authenticate, validate(createWalletSchema), addWallet);
router.get('/users/:userId/wallets', authenticate, validate(userParamsSchema), getWallets);
router.patch('/users/:userId/wallets/:walletId', authenticate, validate(updateWalletSchema), patchWallet);
router.delete('/users/:userId/wallets/:walletId', authenticate, validate(deleteWalletSchema), deleteWallet);

export const walletsRouter = router;
