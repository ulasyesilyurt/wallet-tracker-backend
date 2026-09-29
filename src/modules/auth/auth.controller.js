import { getCurrentUser, loginUser, refreshUser, registerUser } from './auth.service.js';

function wantsRefreshToken(req) {
  return req.get('x-auth-refresh') === 'true';
}

export async function register(req, res) {
  const authResponse = await registerUser(req.validated.body, { issueRefreshToken: wantsRefreshToken(req) });

  res.status(201).json({
    data: authResponse
  });
}

export async function login(req, res) {
  const authResponse = await loginUser(req.validated.body, { issueRefreshToken: wantsRefreshToken(req) });

  res.status(200).json({
    data: authResponse
  });
}

export async function refresh(req, res) {
  res.status(200).json({
    data: await refreshUser(req.body?.refreshToken)
  });
}

export async function me(req, res) {
  res.status(200).json({
    data: {
      user: getCurrentUser(req.auth.user)
    }
  });
}
