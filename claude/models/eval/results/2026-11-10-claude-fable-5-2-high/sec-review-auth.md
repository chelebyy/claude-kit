I found three exploitable vulnerabilities in `auth.js`. This is from reading the code only; nothing was executed, and `auth.js` is the only file in the directory, so the callers were not available to check.

## 1. `auth.js:19`: signature check skipped when `alg` is `none` (critical)

The signature is only compared when the attacker-controlled header says something other than `none`.

- **Attack:** send a forged, unsigned token with header `{"alg":"none"}` and payload `{"sub":1,"role":"admin","exp":9999999999}`:
  ```
  Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOjEsInJvbGUiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OX0.
  ```
  `verifyToken` returns the payload without ever touching `SECRET`.
- **Impact:** full authentication bypass. Anyone without an account can impersonate any user id with any role, including admin, with an expiry of their choosing.

## 2. `auth.js:46`: mass assignment in `updateProfile` (high)

`Object.assign(user, body)` copies every client-supplied field onto the stored user record.

- **Attack (privilege escalation):** a logged-in user sends a profile update with body `{"role":"admin"}`. The next token issued for them at `auth.js:11` carries `role: "admin"`.
- **Attack (account takeover):** the body `{"id":"<victim id>"}` overwrites `user.id`. The next `issueToken(user)` then produces a validly signed token with `sub` set to the victim's id.
- **Impact:** any authenticated user can become admin or take over another account. They can also overwrite any other stored field, such as the password hash.

## 3. `auth.js:38-41`: missing ownership check in `getInvoice` (high)

The function takes `session` but never compares `invoice.ownerId` to `session.sub`.

- **Attack:** user A, logged in with a valid token, requests an invoice id that belongs to user B (for example `getInvoice(db, session, 1002)` when A owns 1001). The response is a 200 with B's full invoice. If ids are sequential or guessable, A can enumerate all of them.
- **Impact:** any authenticated user can read every customer's invoices. Combined with finding 1, no account is needed at all.

One judgement call: I did not report the non-constant-time `!==` signature comparison at `auth.js:19` as a separate finding, because a remote timing attack on it is not practically exploitable here.