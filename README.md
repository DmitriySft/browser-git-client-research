# browser-git-client-research

## Authentication direction

Device login is sufficient for the initial version. The browser client manages
and persists GitHub access and refresh tokens; the customer-operated reverse
proxy is stateless transport, with no token/session store or credential logging.
TLS termination means the proxy still sees credentials in transit.

### Optional future browser-redirect OAuth

- An administrator registers and installs a GitHub App with minimal permissions,
  registers the browser client's callback URL, and configures its client ID and
  client secret in the proxy deployment's secret facility.
- The browser generates `state` and an S256 PKCE challenge, preserves the verifier
  across navigation, and redirects to GitHub's authorization page. On return, it
  validates `state` and sends the authorization code and verifier to the proxy.
- A small stateless token-exchange handler adds the configured client secret and
  calls GitHub's fixed token endpoint. It returns user tokens directly to the
  browser; refresh exchanges can use the same pattern. This requires a handler
  or suitable component, not ordinary reverse-proxy routing alone.
- Fix the upstream, client ID, and callback URL; validate accepted fields, rate
  limit exchanges, and disable credential/body logging and token-response caching.
  The app secret remains server-side; user tokens remain client-managed. PKCE
  protects code redemption, not tokens from malicious browser JavaScript.

Reference: [GitHub App web authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token).

#### Small handler example

Traefik does support interpreted Go middleware through **Yaegi plugins**, as well
as WASM plugins; it is not a general-purpose inline JavaScript/Lua HTTP-function
configuration. A plugin could implement this exchange, but a small private helper
behind Traefik is easier to inspect independently and avoids plugin coupling.
See [Traefik's extension mechanisms](https://doc.traefik.io/traefik/extend/extend-traefik/).

[`examples/oauth_exchange.py`](examples/oauth_exchange.py) is a Python
standard-library example. Configure `GH_CLIENT_ID`, `GH_CLIENT_SECRET`,
`CALLBACK_URL`, and `BROWSER_ORIGIN` through the deployment environment, then run
`python3 examples/oauth_exchange.py`. Only the helper receives the App secret.
[`examples/traefik-oauth.yml`](examples/traefik-oauth.yml) routes the exact
`POST /oauth/exchange` path and CORS preflights to it, with a rate limit.

After validating callback `state`, the browser submits:

```javascript
const response = await fetch(`${proxyOrigin}/oauth/exchange`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, code_verifier: verifier }),
  credentials: "omit",
});
if (!response.ok) throw new Error("GitHub token exchange failed");
const tokens = await response.json(); // Client-managed; never a proxy session.
```

For refresh, submit `{ refresh_token: currentRefreshToken }` instead. The helper
injects the fixed App credentials and callback, refuses caller-supplied upstreams
or additional fields, and returns only token response fields with `no-store`.
Refresh responses replace both client-held tokens; serialize refresh attempts,
since GitHub invalidates the previous tokens on successful refresh.

This is an illustrative helper, not a production HTTP server. Keep port 8081
private; configure HTTPS, ingress body/read timeouts and size limits, trusted
forwarded-IP handling for rate limits, and no credential/body logging at every
proxy/platform layer. CORS is not authentication: non-browser callers can forge
`Origin`. The browser must own `state` validation and PKCE verifier lifecycle.
Tokens exist transiently in transport memory, but are never persisted or cached.
Device login remains the initial path and needs no App secret.