I found three exploitable vulnerabilities in `auth.js`. I did not modify any files.

### 1. Signature verification bypass with `alg: none` (critical)

**Location:** `auth.js:19`

The check `if (header.alg !== 'none' && sign(...) !== s)` skips signature verification whenever the attacker-controlled header says `alg` is `none`. Any payload is then accepted.

**Attack:** Send a forged token with no signature:
- Header `{"alg":"none","typ":"JWT"}` → base64url `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0`
- Payload `{"sub":"1","role":"admin","exp":9999999999}` → base64url of that JSON
- Token: `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.<payload_b64>.` (empty signature after the trailing dot)

```
GET /api/invoices
Authorization: Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.<payload_b64>.
```

**Impact:** Full authentication bypass. An unauthenticated attacker can impersonate any user ID, including admins, and read or modify any data the API exposes.

### 2. Missing ownership check on invoice retrieval (high)

**Location:** `auth.js:38-41`

`getInvoice` takes `session` but never compares `invoice.ownerId` to `session.sub`. The comment on line 37 says `ownerId` is a user id, so the check was clearly intended and is absent.

**Attack:** A logged-in user (or anyone with a valid token, including one from item 3's approach) requests another user's invoice ID:
```
GET /api/invoices/<id-owned-by-another-user>
Authorization: Bearer <valid token for user B>
```
The response returns `200` with the full invoice body of user A.

**Impact:** Broken object-level authorization. Any authenticated user can read every invoice by enumerating or guessing IDs, exposing customer and financial data. Exploitability depends on the caller using `getInvoice` directly and on invoice IDs being guessable or enumerable. Both are likely for sequential or small IDs.

### 3. Mass assignment in profile update enables privilege escalation (high)

**Location:** `auth.js:44-47`

`Object.assign(user, body)` copies every attacker-supplied key into the stored user record, not only `name` and `email`. The `role` field is what `issueToken` (line 11) embeds in new tokens.

**Attack:**
```
PATCH /api/profile
Authorization: Bearer <token for normal user, sub=5>
Content-Type: application/json

{"role": "admin"}
```
Then log in again to get a fresh token. It will carry `role: "admin"`. The same request can also overwrite `id`, `email`, or any other stored field, including a password hash if one lives on the user object.

**Impact:** A normal user becomes an admin, and in the stored record can alter any other field. Severity is high rather than critical because the actual impact depends on how the API enforces `role` elsewhere. I could not see that code, so if `role` is never checked for authorization, this is critical.

### Checked and not reported
- `checkPassword` and `hashPassword` use scrypt with random salts, and `timingSafeEqual` is used correctly, with a length guard.
- The `!==` comparison of the HMAC on line 19 is not a practical timing oracle over a network.
- The 3600-second expiry and `exp` check on line 20 are sound once the signature is verified.