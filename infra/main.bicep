targetScope = 'subscription'

@minLength(1)
@maxLength(40)
@description('Unique azd environment name, used in the resource group name.')
param environmentName string

@description('Azure region for the proxy.')
param location string

@description('Fixed upstream HTTPS origins and exact CORS origin/header/method allowlists.')
param proxySettings object = loadJsonContent('../proxy/settings.json')

@secure()
@description('Base64-encoded JSON object mapping oauthClients names to client secrets, for example {"github":"..."}. Base64 keeps the JSON quotes out of azd parameter substitution.')
param oauthClientSecretsBase64 string = ''

var tags = {
  'azd-env-name': environmentName
  purpose: 'browser-git-proxy-research'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module proxy './proxy.bicep' = {
  name: 'git-proxy'
  scope: resourceGroup
  params: {
    location: location
    suffix: uniqueString(subscription().id, environmentName, location)
    tags: tags
    proxySettings: proxySettings
    oauthClientSecrets: empty(oauthClientSecretsBase64) ? '' : base64ToString(oauthClientSecretsBase64)
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_CONTAINER_APP_NAME string = proxy.outputs.containerAppName
output AZURE_CONTAINER_APP_ENVIRONMENT_NAME string = proxy.outputs.environmentName
output PROXY_URL string = proxy.outputs.url
