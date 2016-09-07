// Native
import path from 'path'

// Packages
import {app, Tray, Menu, BrowserWindow} from 'electron'
import ms from 'ms'
import Config from 'electron-config'
import isDev from 'electron-is-dev'
import {dir as isDirectory} from 'path-type'
import fs from 'fs-promise'

// Ours
import {resolve as resolvePath} from 'app-root-path'
import {innerMenu, outerMenu, deploymentOptions} from './menu'
import {error as showError} from './dialogs'
import deploy from './actions/deploy'
import share from './actions/share'
import autoUpdater from './updates'
import {refreshCache} from './api'
import attachTrayState from './utils/highlight'
import toggleWindow from './utils/toggle-window'

// Prevent garbage collection
// Otherwise the tray icon would randomly hide after some time
let tray = null

// Hide dock icon before the app starts
app.dock.hide()

// Define the application name
app.setName('Now')

// We need this method in the renderer process
// So that we can load all data after the user has logged in
// And before he opens the context menu
global.refreshCache = refreshCache

// Immediately after login, we'll start the auto updater
// from the renderer process
global.autoUpdater = autoUpdater
global.isDev = isDev

// Share error handling between renderer process and the main one
global.errorHandler = showError

// Make sure that unhandled errors get handled
process.on('uncaughtException', err => {
  console.error(err)
  showError('Unhandled error appeared', err)
})

const config = new Config()

// For starting the refreshment right after login
global.startRefresh = tutorialWindow => {
  const timeSpan = ms('10s')

  // Periodically rebuild local cache every 10 seconds
  const interval = setInterval(async () => {
    await refreshCache(null, app, tutorialWindow, interval)
  }, timeSpan)
}

const onboarding = () => {
  const win = new BrowserWindow({
    width: 650,
    height: 430,
    title: 'Welcome to now',
    resizable: false,
    center: true,
    frame: false,
    show: false,
    fullscreenable: false,
    maximizable: false,
    titleBarStyle: 'hidden-inset',
    backgroundColor: '#000'
  })

  win.loadURL('file://' + resolvePath('../app/pages/welcome.html'))
  attachTrayState(win, tray)

  // We need to access it from the "About" window
  // To be able to open it from there
  global.tutorial = win

  // Just hand it back
  return win
}

const aboutWindow = () => {
  const win = new BrowserWindow({
    width: 360,
    height: 425,
    title: 'About',
    resizable: false,
    center: true,
    show: false,
    fullscreenable: false,
    maximizable: false,
    titleBarStyle: 'hidden-inset',
    frame: false,
    backgroundColor: '#ECECEC'
  })

  win.loadURL('file://' + resolvePath('../app/pages/about.html'))
  attachTrayState(win, tray)

  return win
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

const toggleContextMenu = async windows => {
  const deployments = config.get('now.cache.deployments')
  const aliases = config.get('now.cache.aliases')

  const deploymentList = []

  for (const deployment of deployments) {
    const info = deployment
    const index = deployments.indexOf(deployment)

    if (aliases) {
      const aliasInfo = aliases.find(a => deployment.uid === a.deploymentId)

      if (aliasInfo) {
        info.url = aliasInfo.alias
      }
    }

    deploymentList[index] = deploymentOptions(info)
  }

  const generatedMenu = await innerMenu(app, tray, deploymentList, windows)
  const menu = Menu.buildFromTemplate(generatedMenu)

  tray.popUpContextMenu(menu)
}

const isLoggedIn = () => {
  const userProperty = config.has('now.user')
  return userProperty
}

const isDeployable = async directory => {
  const indicators = [
    'package.json',
    'Dockerfile'
  ]

  for (const indicator of indicators) {
    const pathTo = path.join(directory, indicator)
    let stats

    try {
      stats = await fs.lstat(pathTo)
    } catch (err) {
      return false
    }

    if (stats) {
      return true
    }
  }

  return false
}

const fileDropped = async (event, files) => {
  event.preventDefault()
  const loggedIn = isLoggedIn()

  if (!loggedIn) {
    return
  }

  if (files.length > 1) {
    showError('It\'s not yet possible to share multiple files/directories at once.')
    return
  }

  const item = files[0]

  if (!isDirectory(item) || !await isDeployable(item)) {
    await share(item)
    return
  }

  await deploy(item)
}

app.on('ready', async () => {
  if (!isDev && process.platform !== 'linux') {
    global.autoUpdater()
  }

  // DO NOT create the tray icon BEFORE the login status has been checked!
  // Otherwise, the user will start clicking...
  // ...the icon and the app wouldn't know what to do

  // I have no idea why, but path.resolve doesn't work here
  try {
    tray = new Tray(resolvePath('/assets/icons/iconTemplate.png'))
  } catch (err) {
    showError('Could not spawn tray item', err)
    return
  }

  const windows = {
    tutorial: onboarding(),
    about: aboutWindow()
  }

  const toggleActivity = event => {
    const loggedIn = isLoggedIn()

    if (loggedIn && !windows.tutorial.isVisible()) {
      tray.setHighlightMode('selection')
      toggleContextMenu(windows)
    } else {
      toggleWindow(event || null, windows.tutorial)
    }
  }

  // Only allow one intance of Now running
  // at the same time
  app.makeSingleInstance(toggleActivity)

  if (isLoggedIn()) {
    // Periodically rebuild local cache every 10 seconds
    global.startRefresh()
  }

  if (!isLoggedIn()) {
    // Show the tutorial as soon as the content has finished rendering
    // This avoids a visual flash
    windows.tutorial.on('ready-to-show', () => toggleWindow(null, windows.tutorial))
  }

  // When quitting the app, force close the tutorial and about windows
  app.on('before-quit', () => {
    process.env.FORCE_CLOSE = true
  })

  // Define major event listeners for tray
  tray.on('drop-files', fileDropped)
  tray.on('click', toggleActivity)

  let isHighlighted = false
  let submenuShown = false

  tray.on('right-click', async event => {
    if (isLoggedIn() && !windows.tutorial.isVisible()) {
      return
    }

    const menu = Menu.buildFromTemplate(outerMenu(app, windows))

    if (!windows.tutorial.isVisible()) {
      isHighlighted = !isHighlighted
      tray.setHighlightMode(isHighlighted ? 'always' : 'never')
    }

    // Toggle submenu
    tray.popUpContextMenu(submenuShown ? null : menu)
    submenuShown = !submenuShown

    event.preventDefault()
  })
})
