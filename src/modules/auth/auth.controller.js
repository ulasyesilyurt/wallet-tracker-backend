import { getCurrentUser, loginUser, registerUser } from './auth.service.js';

export async function register(req, res) {
  const authResponse = await registerUser(req.validated.body);

  res.status(201).json({
    data: authResponse
  });
}

export async function login(req, res) {
  const authResponse = await loginUser(req.validated.body);

  res.status(200).json({
    data: authResponse
  });
}

export async function me(req, res) {
  res.status(200).json({
    data: {
      user: getCurrentUser(req.auth.user)
    }
  });
}
