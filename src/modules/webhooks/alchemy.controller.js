import { handleAlchemyWebhook } from './alchemy.service.js';
import { recordWebhookSuccess } from '../operations/operationalState.js';

export async function postAlchemyWebhook(req, res) {
  const result = await handleAlchemyWebhook(req.validated.body);
  recordWebhookSuccess();

  res.status(202).json({
    data: result
  });
}
