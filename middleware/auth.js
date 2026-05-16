// const admin = require('firebase-admin');

// let _initialized = false;

// function ensureAdmin() {
//   if (_initialized) return;
//   if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
//     console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — auth verification disabled (dev mode)');
//     _initialized = true;
//     return;
//   }
//   const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
//   admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
//   _initialized = true;
// }

// async function verifyFirebaseToken(token) {
//   ensureAdmin();
//   if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
//     // Dev mode: decode without verify
//     const parts = token.split('.');
//     if (parts.length < 2) throw new Error('Invalid token');
//     const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
//     return { uid: payload.user_id || payload.sub || 'dev-user', email: payload.email || 'dev@localhost' };
//   }
//   return admin.auth().verifyIdToken(token);
// }

// async function verifyToken(req, res, next) {
//   try {
//     const authHeader = req.headers.authorization || '';
//     if (!authHeader.startsWith('Bearer ')) {
//       return res.status(401).json({ error: 'Missing auth token' });
//     }
//     const token = authHeader.slice(7);
//     const decoded = await verifyFirebaseToken(token);
//     req.userId    = decoded.uid;
//     req.userEmail = decoded.email;
//     next();
//   } catch (err) {
//     console.error('Auth error:', err.message);
//     res.status(401).json({ error: 'Unauthorized' });
//   }
// }

// module.exports = { verifyToken, verifyFirebaseToken };




const admin = require('firebase-admin');

let _initialized = false;

function ensureAdmin() {
  if (_initialized) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — auth verification disabled (dev mode)');
    _initialized = true;
    return;
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  _initialized = true;
}

async function verifyFirebaseToken(token) {
  ensureAdmin();
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Dev mode: decode without verify
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('Invalid token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return { uid: payload.user_id || payload.sub || 'dev-user', email: payload.email || 'dev@localhost' };
  }
  return admin.auth().verifyIdToken(token);
}

async function checkUserStatus(uid) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null; // dev mode — skip
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    if (!snap.exists) return 'Account not found';
    const data = snap.data();
    if (data.status === 'deleted') return 'Account deleted';
    if (data.status === 'expired') return 'Account expired';
    if (data.status !== 'approved') return 'Account not approved';
    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
      if (expiresAt < new Date()) return 'Account expired';
    }
    return null;
  } catch (err) {
    console.error('Firestore status check error:', err.message);
    return 'Unable to verify account status';
  }
}

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing auth token' });
    }
    const token = authHeader.slice(7);
    const decoded = await verifyFirebaseToken(token);
    req.userId    = decoded.uid;
    req.userEmail = decoded.email;

    const statusError = await checkUserStatus(decoded.uid);
    if (statusError) {
      return res.status(403).json({ error: statusError });
    }

    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { verifyToken, verifyFirebaseToken };