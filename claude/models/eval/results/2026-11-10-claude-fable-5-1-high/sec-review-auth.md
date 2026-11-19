Three exploitable issues, one of them critical.

**1. `auth.js:19` — Signature bypass via `alg: none` (critical)**
The signature check is skipped whenever the attacker-controlled header says `alg` is `none`. Any client can forge a token for any user and role:

```
header  = base64url({"alg":"none","typ":"JWT"})
payload = base64url({"sub":"<admin-id>","role":"admin","exp":9999999999})
token   = header + "." + payload + ".x"
```

The `verifyToken` function returns that payload as trusted. Impact is full authentication bypass and privilege escalation to any account without knowing the secret.

**2. `auth.js:46` — Mass assignment in `updateProfile` (high)**
The request body is merged straight into the user record with no field allow-list. A logged-in user sends:

```
PATCH /profile
{"role":"admin"}
```

Their stored role becomes `admin`, and the next token issued on line 11 carries it. The same request can overwrite any other persisted field, such as `id` or the stored password hash, to take over or corrupt accounts.

**3. `auth.js:39-41` — Missing ownership check in `getInvoice` (high)**
The `session` argument is ignored. The invoice is returned to any authenticated caller who guesses or enumerates an id:

```
GET /invoices/1042   (as a user who does not own invoice 1042)
```

Impact is disclosure of every customer's invoices to any account holder.

Everything else in the file is sound. Password hashing uses scrypt with a random salt, and comparison is constant-time with a length check. Expiry handling on line 20 correctly rejects missing or non-numeric values.