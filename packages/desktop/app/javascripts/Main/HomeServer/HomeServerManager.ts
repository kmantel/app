import path from 'path'

import {
  HomeServerManagerInterface,
  HomeServerEnvironmentConfiguration,
  Result,
} from '@web/Application/Device/DesktopSnjsExports'

import { WebContents } from 'electron'
import { MessageToWebApp } from '../../Shared/IpcMessages'
import { FilesManagerInterface } from '../File/FilesManagerInterface'
import { HomeServerConfigurationFile } from './HomeServerConfigurationFile'
import { isWindows } from '../Types/Platforms'

const os = require('os')

interface TempHomeServerInterface {
  start(configuration?: unknown): Promise<Result<string>>
  activatePremiumFeatures(username: string): Promise<Result<string>>
  stop(): Promise<Result<string>>
  isRunning(): Promise<boolean>
}

export class HomeServerManager implements HomeServerManagerInterface {
  private readonly HOME_SERVER_CONFIGURATION_FILE_NAME = 'config.json'

  private homeServerConfiguration: HomeServerEnvironmentConfiguration | undefined
  private homeServerDataLocation: string | undefined
  private lastErrorMessage: string | undefined
  private logs: string[] = []

  private readonly LOGS_BUFFER_SIZE = 1000

  private homeServer?: TempHomeServerInterface

  constructor(
    private webContents: WebContents,
    private filesManager: FilesManagerInterface,
  ) {}

  async getHomeServerUrl(): Promise<string | undefined> {
    const homeServerConfiguration = await this.getHomeServerConfigurationObject()
    if (!homeServerConfiguration) {
      return undefined
    }

    return `http://${this.getLocalIP()}:${homeServerConfiguration.port}`
  }

  async isHomeServerRunning(): Promise<boolean> {
    return this.homeServer?.isRunning() ?? false
  }

  async getHomeServerLastErrorMessage(): Promise<string | undefined> {
    return this.lastErrorMessage
  }

  async activatePremiumFeatures(username: string): Promise<string | undefined> {
    if (!this.homeServer) {
      return
    }

    const result = await this.homeServer.activatePremiumFeatures(username)

    if (result.isFailed()) {
      return result.getError()
    }
  }

  async getHomeServerConfiguration(): Promise<string | undefined> {
    if (this.homeServerConfiguration) {
      return JSON.stringify(this.homeServerConfiguration)
    }

    if (!this.homeServerDataLocation) {
      return undefined
    }

    const homeServerConfiguration = await this.filesManager.readJSONFile<HomeServerConfigurationFile>(
      path.join(this.homeServerDataLocation, this.HOME_SERVER_CONFIGURATION_FILE_NAME),
    )
    if (!homeServerConfiguration) {
      return undefined
    }

    return JSON.stringify(homeServerConfiguration.configuration)
  }

  async setHomeServerConfiguration(configurationJSONString: string): Promise<void> {
    try {
      if (!this.homeServerDataLocation) {
        throw new Error('Home server data location is not set.')
      }

      const homeServerConfiguration = JSON.parse(configurationJSONString) as HomeServerEnvironmentConfiguration

      await this.filesManager.ensureDirectoryExists(this.homeServerDataLocation)

      const configurationFile: HomeServerConfigurationFile = {
        version: '1.0.0',
        info: {
          warning: 'Do not edit this file.',
          information:
            'The values below are encrypted with a key created by the desktop application after installation. The key is stored in your secure device keychain.',
          instructions:
            'Put this file inside your home server data location to restore your home server configuration.',
        },
        configuration: homeServerConfiguration,
      }

      await this.filesManager.writeJSONFile(
        path.join(this.homeServerDataLocation, this.HOME_SERVER_CONFIGURATION_FILE_NAME),
        configurationFile,
      )

      this.homeServerConfiguration = homeServerConfiguration
    } catch (error) {
      console.error(`Could not save server configuration: ${(error as Error).message}`)
    }
  }

  async setHomeServerDataLocation(location: string): Promise<void> {
    this.homeServerDataLocation = location
  }

  async stopHomeServer(): Promise<string | undefined> {
    if (!this.homeServer) {
      return
    }

    const result = await this.homeServer.stop()
    if (result.isFailed()) {
      return result.getError()
    }

    return undefined
  }

  async startHomeServer(): Promise<string | undefined> {
    await this.lazyLoadHomeServerOnApplicablePlatforms()

    if (!this.homeServer) {
      return
    }

    try {
      this.lastErrorMessage = undefined
      this.logs = []

      let homeServerConfiguration = await this.getHomeServerConfigurationObject()
      if (!homeServerConfiguration) {
        homeServerConfiguration = this.generateHomeServerConfiguration()
      }
      await this.setHomeServerConfiguration(JSON.stringify(homeServerConfiguration))

      if (!this.homeServerDataLocation) {
        this.lastErrorMessage = 'Home server data location is not set.'

        return this.lastErrorMessage
      }

      const {
        jwtSecret,
        authJwtSecret,
        encryptionServerKey,
        pseudoKeyParamsKey,
        valetTokenSecret,
        port,
        logLevel,
        databaseEngine,
        mysqlConfiguration,
      } = homeServerConfiguration as HomeServerEnvironmentConfiguration

      const environment: { [name: string]: string } = {
        JWT_SECRET: jwtSecret,
        AUTH_JWT_SECRET: authJwtSecret,
        ENCRYPTION_SERVER_KEY: encryptionServerKey,
        PSEUDO_KEY_PARAMS_KEY: pseudoKeyParamsKey,
        VALET_TOKEN_SECRET: valetTokenSecret,
        FILES_SERVER_URL: (await this.getHomeServerUrl()) as string,
        LOG_LEVEL: logLevel ?? 'info',
        VERSION: 'desktop',
        PORT: port.toString(),
        DB_TYPE: databaseEngine,
      }

      if (mysqlConfiguration !== undefined) {
        environment.DB_HOST = mysqlConfiguration.host
        if (mysqlConfiguration.port) {
          environment.DB_PORT = mysqlConfiguration.port.toString()
        }
        environment.DB_USERNAME = mysqlConfiguration.username
        environment.DB_PASSWORD = mysqlConfiguration.password
        environment.DB_DATABASE = mysqlConfiguration.database
      }

      const result = await this.homeServer.start({
        dataDirectoryPath: this.homeServerDataLocation,
        environment,
        logStreamCallback: this.appendLogs.bind(this),
      })

      if (result.isFailed()) {
        this.lastErrorMessage = result.getError()

        return this.lastErrorMessage
      }

      this.webContents.send(MessageToWebApp.HomeServerStarted, await this.getHomeServerUrl())
    } catch (error) {
      return (error as Error).message
    }
  }

  async getHomeServerLogs(): Promise<string[]> {
    return this.logs
  }

  private appendLogs(log: Buffer): void {
    this.logs.push(log.toString())

    if (this.logs.length > this.LOGS_BUFFER_SIZE) {
      this.logs.shift()
    }
  }

  private generateRandomKey(length: number): string {
    return require('crypto').randomBytes(length).toString('hex')
  }

  private getLocalIP() {
    const interfaces = os.networkInterfaces()
    for (const interfaceName in interfaces) {
      const addresses = interfaces[interfaceName]
      for (const address of addresses) {
        if (address.family === 'IPv4' && !address.internal) {
          return address.address
        }
      }
    }
  }

  private async getHomeServerConfigurationObject(): Promise<HomeServerEnvironmentConfiguration | undefined> {
    try {
      const homeServerConfigurationJSON = await this.getHomeServerConfiguration()
      if (!homeServerConfigurationJSON) {
        return undefined
      }

      return JSON.parse(homeServerConfigurationJSON)
    } catch (error) {
      console.error(`Could not get home server configuration: ${(error as Error).message}`)
    }
  }

  private generateHomeServerConfiguration(): HomeServerEnvironmentConfiguration {
    const jwtSecret = this.generateRandomKey(32)
    const authJwtSecret = this.generateRandomKey(32)
    const encryptionServerKey = this.generateRandomKey(32)
    const pseudoKeyParamsKey = this.generateRandomKey(32)
    const valetTokenSecret = this.generateRandomKey(32)
    const port = 3127

    const configuration: HomeServerEnvironmentConfiguration = {
      jwtSecret,
      authJwtSecret,
      encryptionServerKey,
      pseudoKeyParamsKey,
      valetTokenSecret,
      port,
      databaseEngine: 'sqlite',
      logLevel: 'info',
    }

    return configuration
  }

  private async lazyLoadHomeServerOnApplicablePlatforms(): Promise<void> {
    if (isWindows()) {
      return
    }

    if (this.homeServer) {
      return
    }
  }
}
