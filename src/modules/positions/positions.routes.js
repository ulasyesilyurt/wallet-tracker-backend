import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { getPositions } from './positions.controller.js';
import { walletPositionsParamsSchema } from './positions.schemas.js';

const router = Router();

router.get('/wallets/:walletId/positions', validate(walletPositionsParamsSchema), getPositions);

export const positionsRouter = router;
