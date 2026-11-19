'use strict';
// Session tokens, passwords and account endpoints for a small invoicing API.
const crypto = require('crypto');

const SECRET = process.env.TOKEN_SECRET;
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function issueToken(user) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ sub: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

function verifyToken(token) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'none' && sign(`${h}.${p}`) !== s) throw new Error('bad signature');
  if (!(payload.exp > Date.now() / 1000)) throw new Error('expired');
  return payload;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

// db: { users: Map<id, user>, invoices: Map<id, invoice> }; invoice.ownerId is a user id.
function getInvoice(db, session, invoiceId) {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice) return { status: 404 };
  return { status: 200, body: invoice };
}

function updateProfile(db, session, body) {
  const user = db.users.get(session.sub);
  Object.assign(user, body);
  return { status: 200, body: { id: user.id, name: user.name, email: user.email } };
}

module.exports = { issueToken, verifyToken, hashPassword, checkPassword, getInvoice, updateProfile };
