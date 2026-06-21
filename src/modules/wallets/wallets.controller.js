import { createWallet, listWallets, removeWallet, updateWallet } from './wallets.service.js';

export async function addWallet(req, res) {
  const wallet = await createWallet({
    userId: req.auth.user.id,
    ...req.validated.body
  });

  res.status(201).json({
    data: wallet
  });
}

export async function getWallets(req, res) {
  const wallets = await listWallets(req.auth.user.id);

  res.status(200).json({
    data: wallets
  });
}

export async function deleteWallet(req, res) {
  const { walletId } = req.validated.params;
  const deletedWallet = await removeWallet(walletId, req.auth.user.id);

  res.status(200).json({
    data: {
      id: deletedWallet.id,
      deleted: true
    }
  });
}

export async function patchWallet(req, res) {
  const { walletId } = req.validated.params;
  const wallet = await updateWallet(walletId, req.auth.user.id, req.validated.body);

  res.status(200).json({
    data: wallet
  });
}
