import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { getHoldings } from './holdings.controller.js';
import { walletHoldingsParamsSchema } from './holdings.schemas.js';

const router = Router();

router.get('/wallets/:walletId/holdings', validate(walletHoldingsParamsSchema), getHoldings);

export const holdingsRouter = router;
