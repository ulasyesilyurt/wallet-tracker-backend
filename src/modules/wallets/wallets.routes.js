import { Router } from 'express';
import {
  deleteWallet,
  getWalletAlertSettingsController,
  getWallets,
  addWallet,
  patchWallet,
  putWalletAlertSettingsController
} from './wallets.controller.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import {
  createWalletSchema,
  deleteWalletSchema,
  putWalletAlertSettingsSchema,
  updateWalletSchema,
  userParamsSchema,
  walletAlertSettingsParamsSchema
} from './wallets.schemas.js';

const router = Router();

router.post('/users/:userId/wallets', authenticate, validate(createWalletSchema), addWallet);
router.get('/users/:userId/wallets', authenticate, validate(userParamsSchema), getWallets);
router.patch('/users/:userId/wallets/:walletId', authenticate, validate(updateWalletSchema), patchWallet);
router.delete('/users/:userId/wallets/:walletId', authenticate, validate(deleteWalletSchema), deleteWallet);
router.get('/wallets/:walletId/alert-settings', authenticate, validate(walletAlertSettingsParamsSchema), getWalletAlertSettingsController);
router.put('/wallets/:walletId/alert-settings', authenticate, validate(putWalletAlertSettingsSchema), putWalletAlertSettingsController);

export const walletsRouter = router;
