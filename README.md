# browser-git-client-research

## Problem definition

Research whether a strictly browser-only application can provide a shared
file-operation foundation, work with HTTPS-hosted Git repositories, offer simple
GitHub sign-in, and support near-realtime collaboration on the same repository
data. The goal is to establish feasibility, constraints, and open decisions before
grooming and solution selection, not to select an architecture or promise features.

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

The application must run **strictly in the browser, with no application backend**.
Existing Git hosting services are allowed. Do not assume an application-owned
authentication server, CORS proxy, or collaboration relay. Permission to use other
third-party transport services remains unresolved.

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
- Are third-party transport services acceptable within the browser-only constraint?
- What does near-realtime collaboration mean for the intended workflow, and when
  should edits become durable Git checkpoints?
- What collaboration, offline recovery, and conflict-resolution behavior is
  required, including binary files, renames, deletions, and external Git edits?

Grooming will refine these questions and requirements. Implementation planning,
library selection, and synchronization timing decisions come afterward.