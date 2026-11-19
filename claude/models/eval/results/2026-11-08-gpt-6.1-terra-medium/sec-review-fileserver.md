- **High — SSRF and same-origin script execution** — `server.js:33`, `server.js:37`  
  The hostname check accepts any hostname ending in `imgcdn.net`, including an attacker-controlled domain such as `evilimgcdn.net`. A request to `/preview?url=https%3A%2F%2Fevilimgcdn.net%2Fredirect` can make the server fetch that domain; an attacker-controlled redirect can then send the fetch to an internal address such as `http://127.0.0.1:8080/`. The response is returned to the requester. The attacker can also return HTML with a script and direct a victim to the preview URL, causing the script to execute in the server’s origin because the proxy forwards the response content type.

- **High — Process termination by malformed input** — `server.js:15`, `server.js:49`  
  A request such as `GET /% HTTP/1.1` causes `decodeURIComponent` to throw an uncaught exception. The Node process exits, making the service unavailable. Similarly, `/preview?url=invalid` causes an unhandled rejection under the installed Node version.

- **Medium — Reflected cross-site scripting** — `server.js:24`  
  A victim visiting `/%3Csvg%20onload%3Dalert(document.domain)%3E` receives a 404 HTML response containing the decoded, unescaped path. The browser executes the injected script in the server’s origin, allowing an attacker to act as the victim within that origin.

- **Medium — Reading files outside the public directory** — `server.js:17`  
  The containment check accepts sibling paths whose names begin with `public`. For example, `GET /..%2Fpublic-backup%2Fsecrets.txt` resolves to a file under the sibling directory `public-backup`, but its path still starts with the string in `ROOT`. If such a readable sibling file exists in deployment, its contents are returned to the requester.