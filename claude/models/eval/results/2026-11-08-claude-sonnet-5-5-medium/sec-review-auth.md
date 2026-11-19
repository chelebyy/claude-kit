Findings for `auth.js`:

**1. Signature bypass via `alg: "none"`: critical**
- Location: `auth.js:19`
- Attack: The attacker builds their own token and sends it as the bearer token. The header is `{"alg":"none"}`, the payload is `{"sub":"<any user id>","role":"admin","exp":9999999999}`, and the signature is empty or any string. For example: `base64url({"alg":"none"}).base64url({"sub":"1","role":"admin","exp":9999999999}).x`. Line 19 only checks the signature when `header.alg !== 'none'`. The attacker controls the header, so the check is skipped.
- Impact: Anyone can forge a token for any user with any role, including admin, without the secret. This is a full authentication and authorization bypass.

**2. Broken object-level authorization (IDOR) on invoices: high**
- Location: `auth.js:38-41`
- Attack: A logged-in user requests an invoice that belongs to someone else, for example `GET /invoices/<other-id>`. `getInvoice` returns the invoice without comparing `invoice.ownerId` to `session.sub`.
- Impact: Any authenticated user can read every customer's invoices by guessing or enumerating IDs. This exposes financial and personal data.

**3. Mass assignment in profile update, leading to privilege escalation: high**
- Location: `auth.js:46`
- Attack: A user sends `PUT /profile` with the body `{"role":"admin"}`. `Object.assign(user, body)` copies every attacker-supplied field onto the stored user record. The same request can set `id`, `passwordHash` (or whatever field holds the password), or `email`. Any token issued after the change carries `role: admin`, because `issueToken` reads `user.role`.
- Impact: Any user can make themselves an admin. They can also overwrite their stored credentials or other users' linkage fields.