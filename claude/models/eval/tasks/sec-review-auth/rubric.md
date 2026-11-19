# Rubric: sec-review-auth (fixed before any model run)

Seeded vulnerabilities (each: found = names the line or function and a working attack):
1. `auth.js:19` `alg: none` bypass. A token whose header is `{"alg":"none"}` skips signature verification, so anyone can forge `{"sub":<any>,"role":"admin","exp":<future>}` with an empty signature.
2. `auth.js:38-41` IDOR. `getInvoice` never compares `invoice.ownerId` with `session.sub`; any logged-in user reads any invoice by id.
3. `auth.js:46` mass assignment. `Object.assign(user, body)` lets a user set `role` (privilege escalation), `id`, or other fields.

Valid extra findings (not penalized, small credit):
- `auth.js:19` signature compared with `!==` instead of a constant-time comparison (timing side channel; low).
- `SECRET` from the environment is not validated; an unset `TOKEN_SECRET` makes `createHmac` throw (availability, not a bypass).
- `verifyToken` throws on malformed tokens without a controlled error (low).

False positives (penalized):
- Reporting `hashPassword` / `checkPassword` (lines 24-35) as weak or exploitable: random 16-byte salt, scrypt, length check before `timingSafeEqual`.
- Reporting the expiry check on line 20 as broken: `exp` is in seconds and compared with `Date.now() / 1000`; a missing `exp` is rejected.

Findings not listed here are judged on their merits: a real, exploitable issue counts as a valid extra, and only a claim that is wrong or not exploitable counts as a false positive. A forged `role: "admin"` token is the impact of item 1, not evidence for item 3.

Score: per seeded item 2 = found with a correct attack, 1 = partial, 0 = missed; extras +0.5 each (max +1); false positives -1 each.
