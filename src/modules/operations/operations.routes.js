import { Router } from 'express';
import { createOperationsAuth } from './operations.auth.js';

export function createOperationsRouter({ token, getStatus }) {
  const router = Router();
  router.get('/operations/status', createOperationsAuth(token), async (req, res) => {
    const status = await getStatus();
    res.status(200).json({ data: status });
  });
  return router;
}
