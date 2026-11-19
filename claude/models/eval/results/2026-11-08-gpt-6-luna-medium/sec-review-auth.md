**Three exploitable vulnerabilities found.**

- **`auth.js:19` — Forged unsigned tokens accepted (high).** `alg: "none"` skips the signature check. An attacker can send a token with a base64url-encoded header `{"alg":"none"}`, a payload such as `{"sub":"victim","role":"admin","exp":<future Unix timestamp>}`, and any third segment. `verifyToken` accepts it if the payload is unexpired, allowing the attacker to claim another user’s identity and role.

- **`auth.js:41` — Invoice access lacks an ownership check (high).** Any caller with a valid session can request another user’s invoice by supplying its ID; `getInvoice` returns the invoice without comparing `invoice.ownerId` to `session.sub`. This exposes other users’ invoice data.

- **`auth.js:46` — Profile update permits role changes (high).** An authenticated user can submit a body such as `{"role":"admin"}`. `Object.assign` copies it onto the current user, and the function returns success. If role controls authorization elsewhere, this lets the user elevate their privileges.