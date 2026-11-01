param location string
param suffix string
param tags object
param proxySettings object

var image = 'docker.io/library/traefik@sha256:30ff62491aacdb862ceb8c9edcf2627da638d7deafdd4b6dab32fe34f8aa3e90'
var staticConfig = loadTextContent('../proxy/traefik.yml')
var routingConfig = loadTextContent('../proxy/dynamic.yml')

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
      secrets: [
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
    }
    template: {
      // Secret-volume updates alone do not create a new revision.
      revisionSuffix: 'cfg-${uniqueString(staticConfig, routingConfig, image, string(proxySettings))}'
      containers: [
        {
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
          probes: [
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
        }
      ]
      volumes: [
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
      ]
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
