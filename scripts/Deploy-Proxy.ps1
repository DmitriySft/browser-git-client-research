<#
.SYNOPSIS
Redeploys the Git proxy with azd after prompting for the OAuth client secret.

.DESCRIPTION
Selects (or creates) the azd environment, prompts for the client secret of the
OAuth client configured in proxy/settings.json without echoing it, stores it in
the azd environment as OAUTH_CLIENT_SECRETS_BASE64 (a base64-encoded JSON
object, because azd substitutes values into infra/main.parameters.json without
JSON escaping), provisions the proxy, and verifies the deployment with
Test-Proxy.ps1.

azd keeps environment values, including this secret, in plain text in
.azure/<environment>/.env, which is ignored by Git.

.EXAMPLE
./scripts/Deploy-Proxy.ps1

.EXAMPLE
./scripts/Deploy-Proxy.ps1 -KeepSecret
#>
[CmdletBinding()]
param(
    [string] $EnvironmentName = 'bgit-proxy-debug',
    # Used only when the azd environment does not exist in this checkout yet.
    [string] $Location = 'newzealandnorth',
    # Used only when the azd environment does not exist; defaults to the az CLI account.
    [string] $SubscriptionId,
    # Name of the oauthClients entry in proxy/settings.json.
    [string] $OAuthClient = 'github',
    # Reuse the secret already stored in the azd environment without prompting.
    [switch] $KeepSecret,
    [switch] $SkipTest
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $settings = Get-Content -Raw (Join-Path $root 'proxy/settings.json') | ConvertFrom-Json
    if (-not $settings.oauthClients -or -not $settings.oauthClients.PSObject.Properties[$OAuthClient]) {
        throw "proxy/settings.json has no oauthClients entry named '$OAuthClient'."
    }
    $clientId = $settings.oauthClients.$OAuthClient.clientId

    $environments = azd env list --output json | ConvertFrom-Json
    if ($environments.Name -contains $EnvironmentName) {
        azd env select $EnvironmentName
    } else {
        if (-not $SubscriptionId) { $SubscriptionId = az account show --query id --output tsv }
        Write-Host "Creating azd environment '$EnvironmentName' ($Location, subscription $SubscriptionId)."
        azd env new $EnvironmentName --location $Location --subscription $SubscriptionId
    }

    function Set-SecretsValue([string] $Json) {
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Json))
        # Pass the value through a private temporary file so it never appears in a command line.
        $file = [System.IO.Path]::GetTempFileName()
        try {
            if (-not $IsWindows) { chmod 600 $file }
            Set-Content -LiteralPath $file -Value "OAUTH_CLIENT_SECRETS_BASE64=$encoded" -NoNewline
            azd env set --file $file
        } finally {
            Remove-Item -LiteralPath $file -Force
        }
    }

    $existing = azd env get-values --output json | ConvertFrom-Json
    # Migrate the earlier raw-JSON variable, which broke azd's parameter substitution.
    if ($existing.OAUTH_CLIENT_SECRETS) {
        if (-not $existing.OAUTH_CLIENT_SECRETS_BASE64) { Set-SecretsValue $existing.OAUTH_CLIENT_SECRETS }
        azd env unset OAUTH_CLIENT_SECRETS --force
        $existing = azd env get-values --output json | ConvertFrom-Json
    }
    $hasSecret = [bool] $existing.OAUTH_CLIENT_SECRETS_BASE64

    if (-not ($KeepSecret -and $hasSecret)) {
        $hint = if ($hasSecret) { ' (Enter keeps the stored secret)' } else { '' }
        $secret = Read-Host "GitHub OAuth App client secret for '$OAuthClient' (client ID $clientId)$hint" -MaskInput
        if ($secret) {
            if ($secret -notmatch '^[A-Za-z0-9._~-]{8,256}$') {
                throw 'The client secret contains unexpected characters; check that it was pasted correctly.'
            }
            Set-SecretsValue (@{ $OAuthClient = $secret } | ConvertTo-Json -Compress)
            Remove-Variable secret
        } elseif (-not $hasSecret) {
            throw 'A client secret is required; the OAuth helper is disabled without one.'
        }
    }

    azd provision --no-prompt

    if (-not $SkipTest) {
        $proxyUrl = azd env get-value PROXY_URL
        & (Join-Path $PSScriptRoot 'Test-Proxy.ps1') -ProxyUrl $proxyUrl -OAuthClient $OAuthClient
    }
} finally {
    Pop-Location
}
