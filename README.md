# browser-git-client-research

## Problem definition

Research whether a browser application with a customer-operated HTTP proxy can provide a shared
file-operation foundation, work with HTTPS-hosted Git repositories, offer simple
GitHub sign-in, and support near-realtime collaboration on the same repository
data. The goal is to establish feasibility, constraints, and open decisions before
grooming and further solution selection. Confirmed decisions are recorded below;
other technologies remain candidates, not selected solutions or promised features.

## Research questions

1. **In-browser file operations:** What browser-accessible file API can serve as
   the backbone for reading, writing, and organizing repository files? Distinguish
   browser-private storage from user-selected local folders, including their
   permission, persistence, and browser-support differences.
2. **Browser Git client:** Can a Git client running entirely in the browser work
   with GitHub repositories and potentially other HTTPS Git hosts? Investigate
   repository access, supported Git operations, host restrictions, and CORS.
3. **Simple sign-in and repository authorization:** What is the easiest viable
   GitHub SSO flow, with possible extension to GitLab or other hosts, without an
   application backend or embedded client secret? Distinguish signing into the
   application from granting repository permissions; investigate scopes, token
   handling, expiry, and revocation.
4. **Near-realtime collaboration:** How could multiple users collaborate on the
   same Git-backed file data? Distinguish exchanging ongoing edits from durable
   Git checkpoints. Investigate automatic push and merge cadence, concurrent
   pushes and merges, external Git edits, and visible conflict resolution that
   preserves users' data rather than silently overwriting or discarding it.

## Constraints and feasibility criteria

The application logic must run **in the browser, with no application-owned
backend**. Existing Git hosting services are allowed. The customer-operated proxy
decision below replaces the original prohibition on all backend infrastructure.
It does not authorize an application-owned authentication server, a collaboration
relay, or other third-party transport services.

### Decision: customer-operated HTTP proxy

The solution will include a simple HTTP reverse proxy that the customer deploys
and operates using our instructions. The browser application, customer proxy,
and Git host may use separate origins. The proxy will forward the required
authentication and Git HTTP requests and provide narrowly configured CORS
responses where the Git host does not allow direct browser access.

The customer owns the proxy infrastructure and trusts their hosting platform.
Our instructions and deployment configuration must be small, readable, and
auditable so administrators can verify the permitted upstreams, routes, and
methods, and confirm that credentials and repository payloads are not stored,
logged, or forwarded to us. The proxy must not be an open proxy; CORS allowlisting
alone is not access control.

The current deployment candidate is Azure Container Apps with Azure Developer
CLI (`azd`) and Traefik. We will provide additional deployment options later;
these tools are not mandatory dependencies or a completed implementation.
The proxy is a transport component, not a Git engine, credential store, or
collaboration service.

### Mandatory authentication persistence

**Authentication persistence is mandatory:** authentication credentials must
survive browser restarts so users can resume repository access without repeating
sign-in while their authorization remains valid. Session-only or memory-only
token storage is insufficient. Expiry, revocation, or provider policy may still
require re-authentication. If credentials are removed or become unusable, the
application must explicitly request re-authentication without discarding pending
repository edits.

The persistence and credential-protection mechanism remains to be researched;
no storage technology or encryption scheme is selected. Evaluate protection
against malicious same-origin JavaScript separately from persistence: encrypting
tokens with a key available to that JavaScript does not itself prevent token theft.

Research should establish which capabilities are feasible under this constraint,
which depend on browser or host support, and which are blocked or require an
explicit scope decision. Findings should explain the relevant tradeoffs and
limitations, not treat candidate technologies as selected solutions.

Feasibility includes secretless authentication and actual browser-to-host access,
as well as a coherent file and Git workflow. Investigate offline recovery,
interrupted synchronization, binary files, renames and deletions, and conflicts
between local, collaborative, and externally committed changes. Determine whether
pending work can be recovered and unresolved conflicts made visible without data
loss; these are investigation topics, not guarantees already established.

## Unresolved questions for grooming

- Which browsers, storage modes, Git hosts, and repository operations are required?
- Is GitHub sign-in enough, or is broader SSO/provider support needed initially,
  and what repository permissions are acceptable?
- Which customer-proxy deployment options and access controls are needed?
  Are any additional third-party transport services acceptable?
- What does near-realtime collaboration mean for the intended workflow, and when
  should edits become durable Git checkpoints?
- What collaboration, offline recovery, and conflict-resolution behavior is
  required, including binary files, renames, deletions, and external Git edits?

Grooming will refine these questions and requirements within the confirmed
decisions. Detailed implementation planning, library selection, and
synchronization timing decisions come afterward.

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

## Development

Requires Node.js (LTS) and npm.

```sh
npm install
npm run dev              # Vite dev server with hot reload at http://localhost:5170
npm run typecheck:watch  # optional: continuous TypeScript type checking
```

Source maps are enabled, so breakpoints in `src/*.ts` work in browser DevTools.
