- `auth.js:19` — **Critical**  
  **Attack:** Submit the unsigned token `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ2aWN0aW0iLCJyb2xlIjoiYWRtaW4iLCJleHAiOjQxMDI0NDQ4MDB9.`. Its header specifies `"alg":"none"`, so `verifyToken()` skips signature verification and accepts the attacker-controlled payload.  
  **Impact:** Authentication bypass and impersonation of any user, including an administrator.

- `auth.js:41` — **High**  
  **Attack:** An authenticated attacker calls `getInvoice(db, { sub: "attacker" }, "INV-42")` where `INV-42` has `ownerId: "victim"`. The function returns the invoice without comparing `invoice.ownerId` with `session.sub`.  
  **Impact:** Any authenticated user who knows or guesses an invoice ID can read another user’s financial data.

- `auth.js:46` — **High**  
  **Attack:** An ordinary user calls `updateProfile(db, { sub: "attacker" }, { role: "admin" })`. `Object.assign()` writes the attacker-controlled `role` into the stored user; passing that user to `issueToken()` then produces a valid administrator token.  
  **Impact:** Authenticated privilege escalation from an ordinary account to administrator.