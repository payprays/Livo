import { app, protocol } from 'electron'
import { join } from 'path'
import { initDatabase, getDb } from './database'
import { registerFeedHandlers } from './handlers/feed-handlers'
import { registerEntryHandlers } from './handlers/entry-handlers'
import { registerReaderHandlers } from './handlers/reader-handlers'
import { registerAIHandlers } from './handlers/ai-handlers'
import { registerSettingsHandlers } from './handlers/settings-handlers'
import { settingsProvider } from './services/system/settings-provider'
import { registerReadabilityHandlers } from './handlers/readability-handlers'
import { registerDiscoverHandlers } from './handlers/discover-handlers'
import { registerVideoHandlers } from './handlers/video-handlers'
import { registerAgentHandlers } from './handlers/agent-handlers'
import { registerActionHandlers } from './handlers/action-handlers'
import { registerFeverHandlers } from './handlers/fever-handlers'
import { registerTaskHandlers } from './handlers/task-handlers'
import { registerAppHandlers } from './handlers/app-handlers'
import { startAutoRefresh, stopAutoRefresh } from './services/feed/feed-refresh'
import {
  startFeverAutoSync,
  stopFeverAutoSync,
} from './services/fever/fever-sync'
import {
  startAggregatorJobs,
  stopAggregatorJobs,
} from './services/feed/aggregator-jobs'
import {
  getAppCacheDirectoryPath,
  getLogDirectory,
  getUserDataDirectoryPath,
  openDirectory,
} from './services/system/app-shell'
import { applyProxySettings } from './services/system/proxy'
import { WindowManager } from './window-manager'
import { registerAppMenu } from './menu'
import { AppTray } from './services/system/tray'
import { recoverOrphanBilibiliDynamicFeeds } from './services/bilibili/bilibili-orphan-recovery'
import { startCacheMaintenance } from './services/system/cache-maintenance'
import { registerSessionPolicies } from './services/system/session-policies'
import { startBrowserCookieSync } from './services/system/browser-cookies'
import { startDigestSchedule } from './services/ai/digest-schedule'
import { parseDeepLink } from '../shared/deep-link'
import { UpdaterService } from './services/updater'
import { registerUpdaterHandlers } from './handlers/updater-handlers'
import {
  launchLocalApi,
  type LocalApiServer,
} from './services/local-api/local-api-server'

// 自动刷新会触发同步 SQLite 写事务并阻塞主进程 IPC；启动后的前几秒是
// 用户交互最密集的窗口期，延后到首屏数据与交互稳定之后再开始。
const STARTUP_BACKGROUND_DELAY_MS = 8000

export class AppManager {
  readonly windowManager: WindowManager
  private tray: AppTray | null = null
  private stopCacheMaintenance: (() => void) | null = null
  private startupBackgroundTimer: ReturnType<typeof setTimeout> | null = null
  private isQuitting = false
  private databaseReady = false
  private databaseClosed = false
  private localApi: LocalApiServer | null = null
  private updater: UpdaterService

  constructor(
    private readonly options: {
      isDev: boolean
    },
  ) {
    this.updater = new UpdaterService(options.isDev)
    this.windowManager = new WindowManager({
      isDev: options.isDev,
      preloadPath: join(__dirname, '../preload/index.mjs'),
      getCacheImagePath: (fileName) =>
        join(app.getPath('userData'), 'cache', 'images', fileName),
      shouldMinimizeToTray: () => settingsProvider.get().general.minimizeToTray,
      // --hidden: background restarts (rebuild hook) must not take focus.
      shouldStartInTray: () =>
        settingsProvider.get().general.startInTray ||
        process.argv.includes('--hidden'),
      onVisibilityChanged: () => {
        this.tray?.refreshMenu()
      },
    })
  }

  handleSecondInstance(argv: string[]): void {
    const protocolArg = argv.find((arg) => /^livo:\/\//i.test(arg))
    if (protocolArg) {
      this.dispatchDeepLink(protocolArg)
    }
    this.windowManager.focusMainWindow()
  }

  handleOpenUrl(url: string): void {
    this.dispatchDeepLink(url)
    this.windowManager.focusMainWindow()
  }

  handleInitialArgv(argv: string[]): void {
    const protocolArg = argv.find((arg) => /^livo:\/\//i.test(arg))
    if (protocolArg) {
      this.dispatchDeepLink(protocolArg)
    }
  }

  private dispatchDeepLink(url: string): void {
    const action = parseDeepLink(url)
    if (!action) return
    this.windowManager.enqueueDeepLink(action)
  }

  async onReady(): Promise<void> {
    this.configurePlatformIntegration()
    this.registerCacheProtocol()

    // 提前注册 IPC，窗口加载后可以立刻调用启动接口。
    this.registerIpcHandlers()
    registerAppHandlers(this.windowManager, this.updater)
    registerUpdaterHandlers(this.updater)

    // 先创建窗口，再等待数据库初始化；renderer HTML 和骨架屏可以更早加载。
    const mainWindow = this.windowManager.createMainWindow()
    this.updater.setWindow(mainWindow)

    // 数据库初始化与 renderer 启动并行，避免主进程先把开窗链路堵住。
    const dbInitPromise = (async () => {
      await initDatabase()
      await recoverOrphanBilibiliDynamicFeeds()
    })()

    const settings = settingsProvider.get()
    await applyProxySettings(settings)

    this.createTray()
    this.registerMenu()

    registerSessionPolicies()

    // 数据库初始化完成后再安排后台任务；此时窗口与骨架屏已开始加载。
    await dbInitPromise
    this.databaseReady = true
    startBrowserCookieSync()
    startDigestSchedule()

    if (this.isQuitting) return

    void this.startLocalApi()
    this.scheduleStartupBackgroundJobs(mainWindow, settings)
  }

  private async startLocalApi(): Promise<void> {
    const server = await launchLocalApi()
    if (this.isQuitting) {
      void server?.close()
      return
    }
    this.localApi = server
  }

  handleActivate(): void {
    if (!this.windowManager.hasMainWindow()) {
      this.windowManager.createMainWindow()
    } else {
      this.windowManager.focusMainWindow()
    }
    this.tray?.refreshMenu()
  }

  handleBeforeQuit(): void {
    this.isQuitting = true
    this.windowManager.prepareForQuit()
    this.tray?.destroy()
    this.tray = null
    void this.localApi?.close()
    this.localApi = null
    this.stopDatabaseBackedBackgroundJobs()
    this.closeDatabaseOnce()
  }

  handleWindowAllClosed(): void {
    if (process.platform === 'darwin') return

    this.isQuitting = true
    this.stopDatabaseBackedBackgroundJobs()
    this.closeDatabaseOnce()
    app.quit()
  }

  private stopDatabaseBackedBackgroundJobs(): void {
    if (this.startupBackgroundTimer) {
      clearTimeout(this.startupBackgroundTimer)
      this.startupBackgroundTimer = null
    }
    stopFeverAutoSync()
    stopAutoRefresh()
    stopAggregatorJobs()
    if (this.stopCacheMaintenance) {
      this.stopCacheMaintenance()
      this.stopCacheMaintenance = null
    }
  }

  private closeDatabaseOnce(): void {
    if (!this.databaseReady || this.databaseClosed) return
    getDb().close()
    this.databaseClosed = true
  }

  private configurePlatformIntegration(): void {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.livospace.cn')
    }
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('livo')
    }
  }

  private registerCacheProtocol(): void {
    protocol.registerFileProtocol('livo-cache', (request, callback) => {
      const fileName = request.url.replace('livo-cache://', '')
      const filePath = this.windowManager.resolveCacheFile(fileName)
      if (filePath) {
        callback({ path: filePath })
      } else {
        callback({ error: -6 })
      }
    })
  }

  private registerIpcHandlers(): void {
    registerFeedHandlers()
    registerEntryHandlers()
    registerReaderHandlers()
    registerAIHandlers()
    registerSettingsHandlers()
    registerReadabilityHandlers()
    registerDiscoverHandlers()
    registerVideoHandlers()
    registerAgentHandlers()
    registerActionHandlers()
    registerFeverHandlers()
    registerTaskHandlers()
  }

  private createTray(): void {
    this.tray = new AppTray({
      showWindow: () => this.windowManager.focusMainWindow(),
      hideWindow: () => this.windowManager.hideMainWindow(),
      refreshAll: () =>
        this.windowManager.sendAppCommand({ type: 'refresh-all' }),
      openSettings: () =>
        this.windowManager.sendAppCommand({
          type: 'open-settings',
          tab: 'general',
        }),
      checkForUpdates: () =>
        this.windowManager.sendAppCommand({
          type: 'open-settings',
          tab: 'about',
        }),
      quit: () => {
        this.windowManager.prepareForQuit()
        app.quit()
      },
      isWindowVisible: () => this.windowManager.isMainWindowVisible(),
    })
    this.tray.ensureCreated()
  }

  private scheduleStartupBackgroundJobs(
    mainWindow: ReturnType<WindowManager['getMainWindow']>,
    settings: ReturnType<typeof settingsProvider.get>,
  ): void {
    if (this.startupBackgroundTimer) {
      clearTimeout(this.startupBackgroundTimer)
    }

    // 聚合预热、缓存扫描和自动刷新都不是首屏必需；延后启动，
    // 避免刚开窗时和 hydrate / reader snapshot 抢数据库与 IO。
    this.startupBackgroundTimer = setTimeout(() => {
      this.startupBackgroundTimer = null
      startAggregatorJobs()
      this.stopCacheMaintenance = startCacheMaintenance(() =>
        settingsProvider.get(),
      )
      startFeverAutoSync()
      startAutoRefresh(settings.general.refreshInterval, mainWindow, {
        freshnessTTL: settings.data?.freshnessTTL ?? 10,
        concurrency: settings.data?.refreshConcurrency ?? 5,
      })
    }, STARTUP_BACKGROUND_DELAY_MS)
  }

  private registerMenu(): void {
    registerAppMenu({
      windowManager: this.windowManager,
      isDev: this.options.isDev,
      openDataDirectory: () => {
        void openDirectory(getUserDataDirectoryPath())
      },
      openCacheDirectory: () => {
        void openDirectory(getAppCacheDirectoryPath())
      },
      openLogsDirectory: () => {
        void openDirectory(getLogDirectory())
      },
      checkForUpdates: () => {
        void this.updater.checkForAppUpdates(true)
        this.windowManager.sendAppCommand({
          type: 'open-settings',
          tab: 'about',
        })
      },
    })
  }
}

export function createAppManager(options: { isDev: boolean }): AppManager {
  return new AppManager(options)
}
