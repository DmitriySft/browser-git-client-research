# browser-git-client-research

## Local browser app: deployed Git proxy

For development from **`http://localhost:5130`**, use this deployed proxy base URL:

```text
https://git-proxy-wpnzxfaym7kcs.gentlepond-06cb06de.newzealandnorth.azurecontainerapps.io
```

The debugging instance is deployed in Azure New Zealand North in resource group
`rg-bgit-proxy-debug`. It forwards only GitHub Git smart-HTTP requests and permits
CORS only for that exact localhost origin. Other ports, HTTPS localhost, and
loopback IP origins are not allowlisted.

For an isomorphic-git browser client, set `corsProxy` to the base URL above and
keep `url` as the canonical GitHub repository URL, including `.git`. For direct
HTTP requests, prefix the upstream host and repository path with the proxy URL:

```text
https://git-proxy-wpnzxfaym7kcs.gentlepond-06cb06de.newzealandnorth.azurecontainerapps.io/github.com/<owner>/<repository>.git/info/refs?service=git-upload-pack
```

GitHub still enforces repository authorization. This proxy does not provide
sign-in, token exchange, REST API access, or token storage. It scales to zero when
idle, so the first request may be delayed by a cold start. See the
[proxy guide](docs/azure-git-proxy.md) for configuration and deployment instructions.

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

The initial deployment template uses Azure Container Apps with Azure Developer
CLI (`azd`) and Traefik. We will provide additional deployment options later;
these tools are not mandatory dependencies for every future deployment option.
The proxy is a transport component, not a Git engine, credential store, or
collaboration service.

An initial [Azure Git CORS proxy template](docs/azure-git-proxy.md) is available
for debugging: Azure Developer CLI provisions Traefik on Azure Container Apps,
with configurable HTTPS Git hosts and exact CORS origins. The initial deployment
allows only GitHub Git-over-HTTP, an optional OAuth token-exchange route, and
`http://localhost:5130`; APIs are excluded. GitLab-style nested repository groups are supported. The guide covers
prerequisites, deployment, verification, limitations, and cleanup. This public
debugging configuration intentionally has no proxy authentication or IP
restriction; production access controls remain an unresolved decision.

### Decision: isomorphic-git as the browser Git client

The client uses [isomorphic-git](https://isomorphic-git.org/), a pure JavaScript
Git implementation with a browser HTTP client and `corsProxy` support for the
customer proxy. The libgit2 WebAssembly port (`wasm-git`) was considered but is
pre-1.0, large, and needs custom networking glue. Known isomorphic-git limits:
no Git LFS, SSH, or partial clone, and pack data is processed in memory.

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

[GitHub repository access options](docs/github-access-options.md) compares three
ways to obtain a token for the browser client: a fine-grained personal access
token, device flow run by a helper outside the browser, and a generic
confidential-client OAuth helper in the proxy. The client now implements the
third option.

GitHub's token endpoint and Git endpoints do not allow browser (CORS) requests,
and GitHub still requires the client secret when exchanging an authorization
code, even with PKCE. The browser therefore cannot complete OAuth on its own: it
redirects to GitHub for authorization, then sends the code and PKCE verifier to
the proxy's `POST /oauth/<client>/token` route. A stateless sidecar
([`proxy/oauth_helper.py`](proxy/oauth_helper.py)) adds the client secret, calls
the fixed token endpoint, and returns only the token fields. Refresh uses the
same route. The browser client manages and persists the tokens; the proxy stores
no tokens or sessions and does not log credentials. TLS termination means the
proxy still sees credentials in transit.

Both GitHub App and GitHub OAuth App clients work; only the client ID changes.
A GitHub App can be limited to the repositories it is installed on, and its
tokens expire and are refreshed. An OAuth App needs the `repo` scope, which
grants access to every repository the user can reach, and its tokens do not
expire. See [Azure Git CORS proxy](docs/azure-git-proxy.md#oauth-token-helper)
for configuration and deployment.

## Development

Requires Node.js (LTS) and npm.

```sh
npm install
npm run dev              # Vite dev server with hot reload at http://localhost:5130
npm run typecheck:watch  # optional: continuous TypeScript type checking
```

Source maps are enabled, so breakpoints in `src/*.ts` work in browser DevTools.

The defaults in [`src/config.ts`](src/config.ts) point at the deployed debugging
proxy, the research GitHub OAuth App, and the demo repository. Override them in
`.env.local` (see [`.env.example`](.env.example)). Open the app at
`http://localhost:5130`; the OAuth callback is `http://localhost:5130/oauth/callback`.
**Read README.md** clones or pulls the demo repository through the proxy and
shows its README, which is a quick end-to-end check of sign-in and Git access.

The **Books** section demonstrates replacing a CRUD REST API with Git storage:
books are the demo entity, stored by the generic `GitCollection<T>`
(`src/collection.ts`) that any number of entities can reuse. `BookApi`
(`listBooks`, `readBook`, `writeBook`, `deleteBook`) works on the local working
tree only, **Pull books** fetches from GitHub, and **Flush** commits and pushes to
`main`. See [Migrating a CRUD REST client to Git storage](docs/rest-to-git-storage.md).
