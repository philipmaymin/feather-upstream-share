// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using node built-ins only.
import crypto from 'crypto';
import https from 'https';
import http from 'http';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (value) => Buffer.from(String(value), 'base64url');
const SUBJECT = 'mailto:feather@localhost';

function jwkFromKeys({ publicKey, privateKey }) {
  const pub = unb64(publicKey);
  return {
    kty: 'EC', crv: 'P-256',
    x: b64(pub.subarray(1, 33)),
    y: b64(pub.subarray(33, 65)),
    d: b64(unb64(privateKey)),
  };
}

export function generateKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest().subarray(0, length);
}

function encrypt(payload, p256dh, auth) {
  const clientPub = unb64(p256dh);
  const server = crypto.createECDH('prime256v1');
  server.generateKeys();
  const serverPub = server.getPublicKey();
  const shared = server.computeSecret(clientPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, serverPub]);
  const ikm = hkdf(unb64(auth), shared, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const record = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPub.length, 20);
  return Buffer.concat([header, serverPub, body]);
}

function vapidHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const jwt = ['{"typ":"JWT","alg":"ES256"}', JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT,
  })].map(value => b64(Buffer.from(value))).join('.');
  const sig = crypto.sign('sha256', Buffer.from(jwt), {
    key: crypto.createPrivateKey({ key: jwkFromKeys(keys), format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${jwt}.${b64(sig)}, k=${keys.publicKey}`;
}

export function send(sub, payload, keys) {
  return new Promise((resolve) => {
    let body;
    let headers;
    try {
      body = encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
      headers = {
        TTL: '86400',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        Authorization: vapidHeader(sub.endpoint, keys),
      };
    } catch (error) {
      return resolve({ endpoint: sub.endpoint, ok: false, error: error.message });
    }
    const url = new URL(sub.endpoint);
    const req = (url.protocol === 'http:' ? http : https).request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      resolve({ endpoint: sub.endpoint, ok: res.statusCode < 300, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 });
    });
    req.setTimeout(10000, () => req.destroy(new Error('push timed out')));
    req.on('error', error => resolve({ endpoint: sub.endpoint, ok: false, error: error.message }));
    req.end(body);
  });
}
