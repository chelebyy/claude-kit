- **Critical — [auth.js:19](<workdir>/auth.js:19): unsigned token accepted.** An attacker can submit this token with an empty signature:

  ```text
  eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ2aWN0aW0iLCJyb2xlIjoiYWRtaW4iLCJleHAiOjQxMDI0NDQ4MDB9.
  ```

  `verifyToken` accepts it as `victim` with the `admin` role without knowing the secret. This permits impersonation and privilege escalation wherever the returned claims authorize requests.

- **High — [auth.js:41](<workdir>/auth.js:41): other users’ invoices are disclosed.** A session with `sub: "attacker"` can request an invoice ID belonging to `victim`; `getInvoice` returns that invoice without checking its `ownerId`. An attacker who obtains or guesses an invoice ID can read its contents.

- **High — [auth.js:46](<workdir>/auth.js:46): profile update permits privilege escalation.** An authenticated user can submit `{"role":"admin"}` as the profile body. The assignment changes the stored user’s role, and a subsequent `issueToken` for that user includes the admin role. The attacker can then receive the privileges granted to that role.