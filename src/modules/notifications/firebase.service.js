import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { buildSafeFirebaseLogMetadata } from './firebaseLogMetadata.js';

const firebaseLogger = logger.child({ module: 'firebase-notifications' });

let messagingPromise = null;

async function loadFirebaseAdmin() {
  return import('firebase-admin/app').then(async (appModule) => {
    const messagingModule = await import('firebase-admin/messaging');
    return {
      ...appModule,
      ...messagingModule
    };
  });
}

async function createMessaging() {
  const firebaseAdmin = await loadFirebaseAdmin();
  const existingApp = firebaseAdmin.getApps()[0];

  if (existingApp) {
    return firebaseAdmin.getMessaging(existingApp);
  }

  let app;

  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    app = firebaseAdmin.initializeApp({
      credential: firebaseAdmin.cert(serviceAccount)
    });
  } else {
    app = firebaseAdmin.initializeApp();
  }

  return firebaseAdmin.getMessaging(app);
}

async function getMessaging() {
  if (!messagingPromise) {
    messagingPromise = createMessaging().catch((error) => {
      messagingPromise = null;
      throw error;
    });
  }

  return messagingPromise;
}

export async function sendPushNotification(message) {
  if (!env.ENABLE_PUSH_NOTIFICATIONS) {
    firebaseLogger.info({
      ...buildSafeFirebaseLogMetadata(message)
    }, 'Push notifications disabled; skipping delivery');

    return {
      delivered: false,
      skipped: true,
      reason: 'push_notifications_disabled'
    };
  }

  const messaging = await getMessaging();
  const providerMessageId = await messaging.send(message, env.FIREBASE_DRY_RUN);

  firebaseLogger.info({
    ...buildSafeFirebaseLogMetadata(message),
    dryRun: env.FIREBASE_DRY_RUN,
    providerMessageId
  }, 'Push notification sent through Firebase');

  return {
    delivered: true,
    skipped: false,
    providerMessageId
  };
}
