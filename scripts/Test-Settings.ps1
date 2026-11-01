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
Write-Output 'PASS: fixed HTTPS upstreams and explicit CORS settings are valid.'
