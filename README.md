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