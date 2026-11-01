# Azure Git CORS proxy

This azd template deploys a customer-operated Traefik proxy to Azure Container
Apps (ACA). The reusable template forwards Git smart-HTTP requests to configured
HTTPS Git hosts and applies an exact CORS origin allowlist. GitHub is the initial
upstream; GitLab and other hosts using the same protocol can be configured next.
It is not a general website proxy, Git engine, or authentication server.

## Prerequisites

Required for deployment:

- An active Azure subscription and permission to create a resource group and
  `Microsoft.App` resources. Subscription-level Contributor or Owner is sufficient.
- Azure Developer CLI (`azd`), authenticated to the intended subscription.
- PowerShell 7 for the instructions and verification scripts.
- Git to obtain the template and verify Git transport.
- HTTPS connectivity to Azure, the configured Git hosts, and the public container registry.

Azure CLI (`az`), its managed Bicep binary, and the `containerapp` extension are
used below for prerequisite checks and diagnostics. `azd` also manages its own
Bicep binary. A standalone `bicep` executable is not required.

Docker Engine or Podman is only needed for local proxy verification. Deployment
uses the official prebuilt Traefik 3.7.17 image, pinned by digest in
`infra/proxy.bicep`; no local build or Azure Container Registry is needed.
No Python, Node/npm, or host-installed Traefik is required for this template's
scripts. Azure CLI packages manage their own runtime dependencies.

### Install missing tools yourself

These instructions do not automatically install anything. Run the commands for
missing tools yourself. The Linux examples below are PowerShell commands;
Microsoft's Linux installers themselves use Bash.

Install PowerShell using the
[official instructions](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux)
if `pwsh` is unavailable.

Install azd into user-local directories:

```powershell
$bin = Join-Path $HOME '.local/bin'
$install = Join-Path $HOME '.local/share/azd'
New-Item -ItemType Directory -Force -Path $bin, $install | Out-Null
$installer = Join-Path ([System.IO.Path]::GetTempPath()) 'install-azd.sh'
Invoke-WebRequest -Uri 'https://aka.ms/install-azd.sh' -OutFile $installer
Get-Content $installer # Review before executing.
bash $installer --install-folder $install --symlink-folder $bin
$env:PATH = "${bin}:$env:PATH"
azd version
```

Also add `$HOME/.local/bin` to your shell's persistent PATH. For PowerShell, add
`$env:PATH = "${HOME}/.local/bin:$env:PATH"` to your `$PROFILE`.

Install Azure CLI on Ubuntu using the
[official package installer](https://learn.microsoft.com/cli/azure/install-azure-cli-linux?pivots=apt):

```powershell
$installer = Join-Path ([System.IO.Path]::GetTempPath()) 'install-azure-cli.sh'
Invoke-WebRequest -Uri 'https://aka.ms/InstallAzureCLIDeb' -OutFile $installer
Get-Content $installer # Review before executing.
sudo bash $installer
az version
az bicep install
az bicep version
az extension add --name containerapp --upgrade
```

Sign in separately to both tools. Complete device-code sign-in locally; never
paste tokens or device codes into issues, logs, or source files.

```powershell
az login --use-device-code
az account list --output table
az account set --subscription '<your-subscription-id>'
azd auth login --use-device-code
azd auth login --check-status
az account show --query '{name:name,state:state}' --output json
```

Check provider registration:

```powershell
az provider show --namespace Microsoft.App --query registrationState --output tsv
```

If it is not `Registered`, an authorized subscription administrator can run
`az provider register --namespace Microsoft.App --wait`.
Region support does not guarantee available quota or capacity.

## Deploy an instance

### Configure upstreams and CORS

Edit `proxy/settings.json` before provisioning. Its `upstreams` object maps each
proxy route name to a fixed HTTPS origin. Its `allowedOrigins` array specifies
the exact browser origins, including scheme and port.

The initial debugging configuration is:

```json
{
  "upstreams": { "github.com": "https://github.com" },
  "allowedOrigins": ["http://localhost:5130"]
}
```

This is an excerpt: preserve the method/header arrays already in the settings
file. Only `http://localhost:5130` is allowed, not other localhost ports, HTTPS
localhost, or loopback IP origins. To deploy for GitLab instead, replace
`upstreams` with `{"gitlab.com": "https://gitlab.com"}`. For self-hosted Git,
use an entry such as `{"git.example.org": "https://git.example.org"}`.
Multiple fixed hosts may be configured in one instance.

Use lowercase route names containing letters, digits, dots, and hyphens. Set
upstream URLs to canonical HTTPS origins without credentials, paths, trailing
slashes, queries, or fragments. Custom ports are supported. Include any server
path prefix, such as `/scm`, in the repository URL rather than the upstream
origin; the Git route preserves these path segments.

Configure `allowedHeaders` and `exposedHeaders` for the host/client as needed.
Keep `allowedMethods` as GET, POST, and OPTIONS: these are the only supported
Git transport methods. Do not put tokens into settings; the browser supplies
repository credentials with each request.

The `preprovision` PowerShell hook validates these settings and fails explicitly
on malformed values. Bicep embeds the settings into the container environment.
Traefik's file-provider Go template renders routes from those settings at startup;
the same template is used locally and in Azure.

### Provision

Run from the repository root in PowerShell. Use a new environment name for each
instance; `rg-<environment-name>` must not be an unrelated existing resource group.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
./scripts/Test-Settings.ps1
$subscription = az account show --query id --output tsv
azd env new bgit-proxy-debug --subscription $subscription --location newzealandnorth
azd provision --preview
azd up
```

`azure.yaml` deliberately makes `azd up` a single provisioning step: Bicep deploys
both the infrastructure and the prebuilt container. No separate application
package, build, registry, or `azd deploy` step is needed.

The template creates one resource group, a Consumption ACA environment, and one
container app. Azure assigns an HTTPS hostname and terminates TLS. Plain HTTP
redirects to HTTPS. Upstream HTTPS certificates are verified by Traefik.
Only port 8080 is exposed; the health-probe port 8081 is internal.

Retrieve the deployed endpoint and verify it:

```powershell
$proxyUrl = azd env get-value PROXY_URL
./scripts/Test-Proxy.ps1 -ProxyUrl $proxyUrl
```

After an update, ACA may briefly serve the previous revision while switching
traffic. Wait until the latest revision is ready before verifying changed
origins/routes; rerun verification after that transition if necessary.

This verifies exact localhost CORS, Git discovery/transfer preflights (including
nested groups), rejected hosts/non-Git paths/methods, GitHub Git discovery,
preserved GitHub authentication errors, and Git `ls-remote`.
It makes only read-only GitHub requests and does not need a
GitHub token.

For an instance configured for GitLab, pass its route name and a public repository:

```powershell
./scripts/Test-Proxy.ps1 -ProxyUrl $proxyUrl `
  -UpstreamName gitlab.com -Repository gitlab-org/gitlab-test
```

`Test-Proxy.ps1` accepts `-ClientOrigin` for another configured origin and expects
unauthenticated receive-pack discovery on the test repository to be denied.

The app scales to zero when idle and is capped at one replica (0.25 vCPU,
0.5 GiB). Cold starts can delay the first request. Active compute, network usage,
and other Azure charges can apply; this is not a guarantee of free hosting.

## Client request contract

Prefix the configured upstream route name and repository path with the proxy's
HTTPS URL:

```text
https://<proxy-host>/github.com/<owner>/<repository>.git/info/refs?service=git-upload-pack
https://<proxy-host>/github.com/<owner>/<repository>.git/git-upload-pack
https://<proxy-host>/github.com/<owner>/<repository>.git/git-receive-pack
```

Use canonical repository URLs with the `.git` suffix. Nested group paths such
as `/gitlab.com/group/subgroup/project.git` are supported. For every configured
upstream, the template allows only:

| Upstream | Path | Methods |
| --- | --- | --- |
| Configured Git host | `/<groups>/<repo>.git/info/refs?service=git-upload-pack` or `git-receive-pack` | GET |
| Configured Git host | `/<groups>/<repo>.git/git-upload-pack` or `git-receive-pack` | POST |
| Proxy itself | `/healthz` | GET |

OPTIONS preflights are answered locally for the allowed upstream routes.
Unconfigured hosts, website pages, REST APIs, OAuth/device-code endpoints, SSH,
Git LFS, dumb HTTP Git, and redirect rewriting are not supported. Traefik passes
upstream redirects through; use canonical repository URLs so browser requests
do not leave the proxy and encounter upstream CORS restrictions. Obtain Git
credentials separately; this deployment does not proxy sign-in or token exchange.

For an isomorphic-git client, use the ordinary GitHub URL as `url` and the proxy
base URL as `corsProxy`:

```javascript
await git.clone({
  fs,
  http,
  dir: '/repo',
  url: 'https://github.com/octocat/Hello-World.git',
  corsProxy: proxyUrl,
  singleBranch: true,
  depth: 1
})
```

This is an integration example, not a selection or implementation of the
research client's Git or filesystem libraries.

CORS permits only the exact configured origins, initially
`http://localhost:5130`. The allowed origin is echoed, never `*`.
Authorization, Content-Type, Accept, and Git-Protocol
request headers are allowed. Use `credentials: 'omit'` for browser fetches;
Git credentials travel in `Authorization`, not proxy cookies.
Upstream error responses retain CORS so the client can handle expired tokens.

## Public debugging exposure and privacy

This debugging template intentionally has no proxy authentication or IP
restriction. GitHub still enforces repository permissions, and public
repositories remain readable without a token. CORS is only a browser policy:
non-browser clients can use this public proxy too, so it can be abused and incur
costs. Fixed upstream hosts and limited routes prevent it from being an
arbitrary-destination forward proxy; they do not make it private.
Revisit ingress restrictions or authentication before production use.

Traefik forwards Authorization and Git payloads without storing them. Request
access logging and telemetry are disabled; only error-level operational logs
are enabled. Cookies are stripped in both directions and responses are marked
`Cache-Control: no-store`. Do not enable DEBUG/access logging with real tokens.
Azure still operates the infrastructure and can maintain platform diagnostics;
the customer must trust Azure as well as the proxy operator.

The two ACA secret entries contain **public YAML configuration only**, not
credentials. Secret volumes avoid building a custom image. Configuration
content and upstream/CORS settings determine the revision suffix, so edits
create a new revision.

## Local verification and debugging

For Podman, run from the repository root:

```powershell
$image = 'docker.io/library/traefik@sha256:30ff62491aacdb862ceb8c9edcf2627da638d7deafdd4b6dab32fe34f8aa3e90'
$config = (Resolve-Path ./proxy).Path
./scripts/Test-Settings.ps1
$settings = Get-Content ./proxy/settings.json -Raw |
  ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress
podman run --detach --name bgit-proxy-local `
  --publish 127.0.0.1:18080:8080 --volume "${config}:/etc/traefik:ro" `
  --env "PROXY_SETTINGS=$settings" `
  $image --configFile=/etc/traefik/traefik.yml
try {
  ./scripts/Test-Proxy.ps1 -ProxyUrl http://127.0.0.1:18080
} finally {
  podman rm --force bgit-proxy-local
}
```

Docker Engine can run the same commands with `docker` substituted for `podman`.
Only remove the container you created. Start-up can take a few seconds; retry
the verification if the local container is not ready yet.

Inspect the Azure app without retrieving or printing secrets:

```powershell
$group = azd env get-value AZURE_RESOURCE_GROUP
$app = azd env get-value AZURE_CONTAINER_APP_NAME
az containerapp show --resource-group $group --name $app `
  --query '{state:properties.provisioningState,fqdn:properties.configuration.ingress.fqdn}' --output json
az containerapp revision list --resource-group $group --name $app --output table
az containerapp logs show --resource-group $group --name $app --type system --tail 30
```

There is no Log Analytics workspace or diagnostic export. Console/system log
streaming can be used for live operational investigation. Never paste tokens or
repository payloads into diagnostics.

After editing `proxy/settings.json`, `proxy/traefik.yml`, `proxy/dynamic.yml`,
or infrastructure, run `./scripts/Test-Settings.ps1` and
`az bicep build --file infra/main.bicep --stdout` for validation, verify locally,
then run `azd up` again and re-run `Test-Proxy.ps1`.

Settings are read from the current checkout for every environment. When deploying
instances with different hosts/origins, set the intended settings before every
`azd up`; do not accidentally redeploy another instance with the wrong settings.

## Remove an instance

Select the intended azd environment and review its resource group before
deleting anything:

```powershell
azd env select bgit-proxy-debug
azd env get-value AZURE_RESOURCE_GROUP
azd down
```

`azd down` deletes that instance's Azure resources. It is not part of deployment
or verification and must be an explicit operator action.
