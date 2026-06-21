import { handleAlchemyWebhook } from './alchemy.service.js';

export async function postAlchemyWebhook(req, res) {
  const result = await handleAlchemyWebhook(req.validated.body);

  res.status(202).json({
    data: result
  });
}
