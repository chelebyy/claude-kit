I found three exploitable vulnerabilities in `auth.js`.

### 1. Signature check skipped when `alg` is `none` (forged tokens): `auth.js:19`
**Severity: Critical**

`verifyToken` only checks the signature if `header.alg !== 'none'`. The header comes from the token itself, so an attacker can set it to `none` and skip the check entirely.

**Attack:** Build a token with any claims you want and an empty signature:
```
header  = base64url({"alg":"none","typ":"JWT"})   -> eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0
payload = base64url({"sub":"<victim-id>","role":"admin","exp":9999999999})
token   = eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.<payload>.
```
Send it as `Authorization: Bearer <token>`. `verifyToken` returns the payload unchanged.

**Impact:** No credentials are needed. An attacker can pose as any user, including an admin, and the token never expires.

### 2. Invoices are not checked against their owner (IDOR): `auth.js:38-41`
**Severity: High**

`getInvoice` takes `session` but never uses it. It never compares `invoice.ownerId` to `session.sub`, so it returns any invoice that exists.

**Attack:** Log in as any normal user and request other users' invoice IDs, e.g. `GET /invoices/1`, `GET /invoices/2`, and so on. Each request returns `200` with the full invoice.

**Impact:** Any logged-in user can read every customer's invoices, including billing details and amounts.

### 3. Profile update writes every field from the request (mass assignment): `auth.js:46`
**Severity: High**

`Object.assign(user, body)` copies every field the client sends onto the stored user record. That includes `role`, `id` and the password hash.

**Attack:**
```
PATCH /profile
{"role":"admin"}
```
The stored user now has `role: "admin"`. The next `issueToken(user)` call (line 11) puts that role into a validly signed token.

Other payloads work the same way:
- `{"id":"<victim-id>"}` makes later tokens carry `sub = victim-id`, so the attacker acts as the victim.
- Overwriting the stored password-hash field (whatever the app calls it) with a `salt:hash` the attacker generated lets them choose the password.

**Impact:** A user can make themselves admin and take over other accounts. This works even if finding 1 is fixed.

The password functions (`hashPassword`/`checkPassword`) and token issuing (`issueToken`) have no exploitable problems.