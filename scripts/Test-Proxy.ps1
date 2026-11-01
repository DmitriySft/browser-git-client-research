[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [uri] $ProxyUrl,
    [string] $UpstreamName = 'github.com',
    [string] $Repository = 'octocat/Hello-World',
    [string] $ClientOrigin = 'http://localhost:5130',
    # Name of a configured oauthClients entry to verify, for example 'github'.
    [string] $OAuthClient
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$base = $ProxyUrl.AbsoluteUri.TrimEnd('/')
$repositoryPath = "/$UpstreamName/$Repository.git"
$gitPath = "$repositoryPath/info/refs?service=git-upload-pack"

function Assert-Condition([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Send-Request([string] $Path, [string] $Method = 'GET', [hashtable] $Headers = @{}) {
    Invoke-WebRequest -Uri "$base$Path" -Method $Method -Headers $Headers `
        -SkipHttpErrorCheck -TimeoutSec 240
}

$health = Send-Request '/healthz'
$healthContent = if ($health.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($health.Content)
} else {
    "$($health.Content)"
}
Assert-Condition ($health.StatusCode -eq 200 -and $healthContent -eq 'OK') 'Health endpoint failed.'

foreach ($origin in @($ClientOrigin)) {
    foreach ($route in @(
        @{ Path = $gitPath; Method = 'GET' }
        @{ Path = "$repositoryPath/git-upload-pack"; Method = 'POST' }
        @{ Path = "$repositoryPath/git-receive-pack"; Method = 'POST' }
        @{ Path = "$repositoryPath/info/refs?service=git-receive-pack"; Method = 'GET' }
        @{ Path = "/$UpstreamName/group/subgroup/project.git/info/refs?service=git-upload-pack"; Method = 'GET' }
        @{ Path = "/$UpstreamName/group/subgroup/project.git/git-upload-pack"; Method = 'POST' }
    )) {
        $preflight = Send-Request $route.Path 'OPTIONS' @{
            Origin = $origin
            'Access-Control-Request-Method' = $route.Method
            'Access-Control-Request-Headers' = 'authorization,content-type,git-protocol'
        }
        Assert-Condition ($preflight.StatusCode -eq 200) "Preflight failed for $origin on $($route.Path)."
        Assert-Condition ("$($preflight.Headers['Access-Control-Allow-Origin'])" -eq $origin) "Origin not allowed: $origin."
        Assert-Condition ("$($preflight.Headers['Access-Control-Allow-Headers'])" -match '(?i)Authorization') 'Authorization header is not allowed.'
        Assert-Condition ("$($preflight.Headers['Access-Control-Allow-Methods'])" -match $route.Method) 'Required method is not allowed.'
    }
}

foreach ($origin in @('http://localhost:5173', 'http://localhost:3000', 'https://localhost:5130', 'http://127.0.0.1:5130', 'http://[::1]:5130', 'https://example.com', 'http://localhost.example.com:5130', 'http://localhost:5130.evil.example', 'null')) {
    if ($origin -ceq $ClientOrigin) { continue }
    $response = Send-Request $gitPath 'OPTIONS' @{
        Origin = $origin
        'Access-Control-Request-Method' = 'GET'
    }
    Assert-Condition (-not $response.Headers.ContainsKey('Access-Control-Allow-Origin')) "Unexpected CORS allowance for $origin."
    $actual = Send-Request '/healthz' 'GET' @{ Origin = $origin }
    Assert-Condition (-not $actual.Headers.ContainsKey('Access-Control-Allow-Origin')) "Unexpected actual-response CORS allowance for $origin."
}

foreach ($path in @('/example.com/repo.git/info/refs?service=git-upload-pack', "/$UpstreamName.evil.example/user", '/https://example.com', '/unconfigured', "/$UpstreamName/login/device/code", "/$UpstreamName/login/oauth/access_token", "/$UpstreamName/settings", '/api.github.com/user', "$repositoryPath/info/refs?service=other")) {
    $response = Send-Request $path
    Assert-Condition ($response.StatusCode -eq 404) "Unexpected route allowed: $path."
}
$wrongMethod = Send-Request $gitPath 'DELETE'
Assert-Condition ($wrongMethod.StatusCode -eq 404) 'Unexpected HTTP method allowed.'

$discovery = Send-Request $gitPath 'GET' @{ Origin = $ClientOrigin }
Assert-Condition ($discovery.StatusCode -eq 200) 'Git discovery failed.'
Assert-Condition ("$($discovery.Headers['Content-Type'])" -match 'application/x-git-upload-pack-advertisement') 'Unexpected Git discovery response type.'
Assert-Condition ("$($discovery.Headers['Access-Control-Allow-Origin'])" -eq $ClientOrigin) 'Actual response is missing CORS.'
Assert-Condition ("$($discovery.Headers['Vary'])" -match 'Origin') 'Actual response is missing Vary: Origin.'

$unauthorized = Send-Request "$repositoryPath/info/refs?service=git-receive-pack" 'GET' @{ Origin = $ClientOrigin }
Assert-Condition ($unauthorized.StatusCode -in @(401, 403)) 'Upstream authentication enforcement was not preserved.'
Assert-Condition ("$($unauthorized.Headers['Access-Control-Allow-Origin'])" -eq $ClientOrigin) 'Upstream authentication error is missing CORS.'

$refs = git -c credential.helper= -c "http.extraHeader=Origin: $ClientOrigin" `
    ls-remote "$base$repositoryPath" HEAD
Assert-Condition ("$refs" -match '^[0-9a-f]{40}\s+HEAD$') 'Git ls-remote failed through the proxy.'

$oauthMessage = ''
if ($OAuthClient) {
    $tokenPath = "/oauth/$OAuthClient/token"
    $preflight = Send-Request $tokenPath 'OPTIONS' @{
        Origin = $ClientOrigin
        'Access-Control-Request-Method' = 'POST'
        'Access-Control-Request-Headers' = 'content-type'
    }
    Assert-Condition ($preflight.StatusCode -eq 200) 'OAuth token preflight failed.'
    Assert-Condition ("$($preflight.Headers['Access-Control-Allow-Origin'])" -eq $ClientOrigin) 'OAuth token preflight is missing CORS.'
    # An invalid grant is rejected by the helper without contacting the provider.
    $invalid = Invoke-WebRequest -Uri "$base$tokenPath" -Method POST -SkipHttpErrorCheck -TimeoutSec 60 `
        -Headers @{ Origin = $ClientOrigin } -ContentType 'application/json' -Body '{"grant_type":"password"}'
    Assert-Condition ($invalid.StatusCode -eq 400) "OAuth helper did not reject an invalid grant ($($invalid.StatusCode)); is the client secret configured?"
    Assert-Condition ("$($invalid.Headers['Access-Control-Allow-Origin'])" -eq $ClientOrigin) 'OAuth error response is missing CORS.'
    Assert-Condition ("$($invalid.Headers['Cache-Control'])" -match 'no-store') 'OAuth response is cacheable.'
    $foreign = Invoke-WebRequest -Uri "$base$tokenPath" -Method POST -SkipHttpErrorCheck -TimeoutSec 60 `
        -Headers @{ Origin = 'https://example.com' } -ContentType 'application/json' -Body '{}'
    Assert-Condition ($foreign.StatusCode -eq 403) 'OAuth helper accepted an unexpected origin.'
    foreach ($path in @("/oauth/$OAuthClient/authorize", '/oauth/unconfigured-client/token', "/oauth/$OAuthClient/token/x")) {
        Assert-Condition ((Send-Request $path 'POST').StatusCode -eq 404) "Unexpected OAuth route allowed: $path."
    }
    Assert-Condition ((Send-Request $tokenPath 'GET').StatusCode -eq 404) 'Unexpected OAuth method allowed.'
    $oauthMessage = ", OAuth client $OAuthClient token route"
}

Write-Output "PASS: health, exact $ClientOrigin CORS, preflights, rejected origins/upstreams/non-Git routes/methods, Git discovery, upstream authentication, and Git ls-remote$oauthMessage."
