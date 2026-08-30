// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using node built-ins only.
import crypto from 'crypto';
import dns from 'dns/promises';
import https from 'https';
import net from 'net';

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

function publicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicPushAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return publicIpv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized.startsWith('::ffff:')) return false;
  const first = Number.parseInt(normalized.split(':')[0], 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  if (normalized.startsWith('2001:db8:')
    || normalized.startsWith('2001::')
    || normalized.startsWith('2001:0:')
    || normalized.startsWith('2001:2:')
    || normalized.startsWith('2001:10:')
    || normalized.startsWith('2001:20:')
    || normalized.startsWith('2002:')
    || normalized.startsWith('3fff:')) return false;
  return true;
}

export function validPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !!hostname
      && (!net.isIP(hostname) || isPublicPushAddress(hostname));
  } catch {
    return false;
  }
}

async function safeAddresses(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicPushAddress(entry.address))) {
    throw new Error('push endpoint did not resolve to a public address');
  }
  return addresses;
}

export async function send(sub, payload, keys) {
  let body;
  let headers;
  let url;
  let addresses;
  try {
    if (!validPushEndpoint(sub.endpoint)) throw new Error('invalid push endpoint');
    url = new URL(sub.endpoint);
    addresses = await safeAddresses(url.hostname.replace(/^\[|\]$/g, ''));
    body = encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
    headers = {
      TTL: '86400',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': body.length,
      Authorization: vapidHeader(sub.endpoint, keys),
    };
  } catch (error) {
    return { endpoint: sub.endpoint, ok: false, error: error.message };
  }

  return new Promise((resolve) => {
    const lookup = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) return callback(null, addresses);
      const family = typeof options === 'object' ? options.family : 0;
      const selected = addresses.find(entry => !family || entry.family === family) || addresses[0];
      callback(null, selected.address, selected.family);
    };
    const req = https.request(url, { method: 'POST', headers, lookup }, (res) => {
      res.resume();
      resolve({ endpoint: sub.endpoint, ok: res.statusCode < 300, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 });
    });
    req.setTimeout(10000, () => req.destroy(new Error('push timed out')));
    req.on('error', error => resolve({ endpoint: sub.endpoint, ok: false, error: error.message }));
    req.end(body);
  });
}
