param location string
param suffix string
param tags object
param proxySettings object

@secure()
param oauthClientSecrets string

var image = 'docker.io/library/traefik@sha256:30ff62491aacdb862ceb8c9edcf2627da638d7deafdd4b6dab32fe34f8aa3e90'
var staticConfig = loadTextContent('../proxy/traefik.yml')
var routingConfig = loadTextContent('../proxy/dynamic.yml')
var oauthImage = 'docker.io/library/python@sha256:7984cf56ceaddebe4fefeb75d64000b9f45d8b77b11a09b24524da6cdc3af0c8'
var oauthHelper = loadTextContent('../proxy/oauth_helper.py')
var hasOAuth = !empty(proxySettings.?oauthClients ?? {})
var oauthSecretsValue = empty(oauthClientSecrets) ? '{}' : oauthClientSecrets
// Secret-volume and secret-reference updates alone do not create a new revision.
var revisionInputs = hasOAuth
  ? [staticConfig, routingConfig, image, string(proxySettings), oauthHelper, oauthImage, oauthSecretsValue]
  : [staticConfig, routingConfig, image, string(proxySettings)]

var configSecrets = [
  {
    name: 'static-config'
    // This is public configuration, mounted using ACA's secret-volume API.
    #disable-next-line use-secure-value-for-secure-inputs
    value: staticConfig
  }
  {
    name: 'routing-config'
    #disable-next-line use-secure-value-for-secure-inputs
    value: routingConfig
  }
]
var oauthSecrets = [
  {
    name: 'oauth-helper-script'
    // Public helper source code, mounted like the Traefik configuration.
    #disable-next-line use-secure-value-for-secure-inputs
    value: oauthHelper
  }
  {
    // The only credential in this template: OAuth client secrets by client name.
    name: 'oauth-client-secrets'
    value: oauthSecretsValue
  }
]

var traefikProbes = [
  for probeType in ['Startup', 'Liveness', 'Readiness']: {
    type: probeType
    httpGet: {
      path: '/ping'
      port: 8081
    }
    periodSeconds: 10
    timeoutSeconds: 2
    failureThreshold: probeType == 'Startup' ? 30 : 3
  }
]
var traefikContainer = {
  name: 'traefik'
  image: image
  args: [
    '--configFile=/etc/traefik/traefik.yml'
  ]
  env: [
    {
      name: 'PROXY_SETTINGS'
      value: string(proxySettings)
    }
  ]
  resources: {
    cpu: json('0.25')
    memory: '0.5Gi'
  }
  volumeMounts: [
    {
      volumeName: 'configuration'
      mountPath: '/etc/traefik'
    }
  ]
  probes: traefikProbes
}
var oauthContainer = {
  name: 'oauth-helper'
  image: oauthImage
  command: [
    'python'
    '/opt/oauth-helper/oauth_helper.py'
  ]
  env: [
    {
      name: 'PROXY_SETTINGS'
      value: string(proxySettings)
    }
    {
      name: 'OAUTH_CLIENT_SECRETS'
      secretRef: 'oauth-client-secrets'
    }
  ]
  resources: {
    cpu: json('0.25')
    memory: '0.5Gi'
  }
  volumeMounts: [
    {
      volumeName: 'oauth-helper'
      mountPath: '/opt/oauth-helper'
    }
  ]
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-git-${suffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: ''
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource containerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'git-proxy-${suffix}'
  location: location
  tags: tags
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'http'
      }
      secrets: hasOAuth ? concat(configSecrets, oauthSecrets) : configSecrets
    }
    template: {
      revisionSuffix: 'cfg-${uniqueString(join(revisionInputs, '\n'))}'
      containers: hasOAuth ? [traefikContainer, oauthContainer] : [traefikContainer]
      volumes: concat(
        [
          {
            name: 'configuration'
            storageType: 'Secret'
            secrets: [
              {
                secretRef: 'static-config'
                path: 'traefik.yml'
              }
              {
                secretRef: 'routing-config'
                path: 'dynamic.yml'
              }
            ]
          }
        ],
        hasOAuth
          ? [
              {
                name: 'oauth-helper'
                storageType: 'Secret'
                secrets: [
                  {
                    secretRef: 'oauth-helper-script'
                    path: 'oauth_helper.py'
                  }
                ]
              }
            ]
          : []
      )
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output containerAppName string = containerApp.name
output environmentName string = environment.name
output url string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
