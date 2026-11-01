[CmdletBinding()]
param(
    [string] $SettingsPath = (Join-Path $PSScriptRoot '../proxy/settings.json')
)

$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json -AsHashtable

function Assert-Origin([string] $Value, [bool] $HttpsOnly) {
    $uri = $null
    if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -or
        $uri.Scheme -notin @('http', 'https') -or
        ($HttpsOnly -and $uri.Scheme -ne 'https') -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $Value -cne $uri.GetLeftPart([UriPartial]::Authority) -or
        $uri.Host.Contains('*')) {
        throw "Expected a canonical $(if ($HttpsOnly) { 'HTTPS ' })origin without credentials, path, query, fragment, or wildcard: $Value"
    }
}

if ($settings.upstreams -isnot [System.Collections.IDictionary] -or $settings.upstreams.Count -eq 0) {
    throw 'At least one fixed upstream is required.'
}
foreach ($name in $settings.upstreams.Keys) {
    if ($name -cnotmatch '^[a-z0-9][a-z0-9.-]*$') {
        throw "Invalid upstream route name: $name. Use lowercase letters, digits, dots, and hyphens."
    }
    Assert-Origin $settings.upstreams[$name] $true
}
if ($settings.allowedOrigins -isnot [array] -or $settings.allowedOrigins.Count -eq 0) {
    throw 'At least one explicit allowedOrigins entry is required.'
}
foreach ($origin in $settings.allowedOrigins) { Assert-Origin $origin $false }

foreach ($property in @('allowedMethods', 'allowedHeaders', 'exposedHeaders')) {
    if ($settings[$property] -isnot [array] -or $settings[$property].Count -eq 0) {
        throw "$property must be a nonempty array."
    }
    foreach ($value in $settings[$property]) {
        if ($value -isnot [string] -or $value -notmatch '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$') {
            throw "Invalid $property entry: $value"
        }
    }
}
foreach ($method in $settings.allowedMethods) {
    if ($method -cnotin @('GET', 'POST', 'OPTIONS')) {
        throw "Unsupported CORS method: $method"
    }
}
foreach ($method in @('GET', 'POST', 'OPTIONS')) {
    if ($settings.allowedMethods -cnotcontains $method) {
        throw "Git-over-HTTP CORS requires $method."
    }
}

$oauthClients = $settings['oauthClients']
if ($null -ne $oauthClients) {
    if ($oauthClients -isnot [System.Collections.IDictionary]) {
        throw 'oauthClients must be an object keyed by client name.'
    }
    if ($oauthClients.Count -gt 0 -and $settings.allowedHeaders -notcontains 'Content-Type') {
        throw 'OAuth token requests require Content-Type in allowedHeaders.'
    }
    foreach ($name in $oauthClients.Keys) {
        if ($name -cnotmatch '^[a-z0-9][a-z0-9.-]*$') {
            throw "Invalid OAuth client name: $name. Use lowercase letters, digits, dots, and hyphens."
        }
        $client = $oauthClients[$name]
        if ($client -isnot [System.Collections.IDictionary] -or
            @($client.Keys | Where-Object { $_ -cnotin @('tokenUrl', 'clientId', 'redirectUris') }).Count -gt 0) {
            throw "OAuth client $name may contain only tokenUrl, clientId, and redirectUris."
        }
        $tokenUrl = $null
        if ($client.tokenUrl -isnot [string] -or
            -not [uri]::TryCreate($client.tokenUrl, [UriKind]::Absolute, [ref] $tokenUrl) -or
            $tokenUrl.Scheme -ne 'https' -or $tokenUrl.UserInfo -or $tokenUrl.Query -or $tokenUrl.Fragment) {
            throw "OAuth client $name needs an HTTPS tokenUrl without credentials, query, or fragment."
        }
        if ($client.clientId -isnot [string] -or $client.clientId -notmatch '^[A-Za-z0-9._~-]{1,256}$') {
            throw "OAuth client $name needs a clientId."
        }
        if ($client.redirectUris -isnot [array] -or $client.redirectUris.Count -eq 0) {
            throw "OAuth client $name needs at least one redirect URI."
        }
        foreach ($redirect in $client.redirectUris) {
            $uri = $null
            if ($redirect -isnot [string] -or
                -not [uri]::TryCreate($redirect, [UriKind]::Absolute, [ref] $uri) -or
                $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
                $settings.allowedOrigins -cnotcontains $uri.GetLeftPart([UriPartial]::Authority)) {
                throw "OAuth redirect URI must be on an allowed origin, without credentials, query, or fragment: $redirect"
            }
        }
    }
}
Write-Output 'PASS: fixed HTTPS upstreams, explicit CORS, and OAuth client settings are valid.'
