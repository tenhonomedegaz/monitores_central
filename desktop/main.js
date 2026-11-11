const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, shell, dialog, ipcMain } = require('electron');
const { spawn, execSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

app.setName('Monitores Central');
if (process.platform === 'win32') {
  app.setAppUserModelId('br.local.monitorescentral');
}

const isBackgroundStart = process.argv.includes('--background');
const appRoot = app.getAppPath();
const iconPath = process.platform === 'win32'
  ? path.join(appRoot, 'build', 'icon.ico')
  : path.join(appRoot, 'build', 'icon.png');

let serverPort = 8080;

const servers = [
  {
    name: 'Servidor Unificado',
    port: 8080,
    cwd: appRoot,
    exe: '',
    url: 'http://127.0.0.1:8080'
  }
];

function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(Math.floor(Math.random() * 10000) + 50000);
    });
  });
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
const childProcesses = [];
const seenNotificationIds = new Map();
let notificationTimer = null;
let logFile = null;

function log(message) {
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('userData'), 'desktop.log');
    }
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (_err) {
    // Logging must never stop the app from opening.
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(300);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function findPythonCommand() {
  if (process.platform !== 'win32') {
    return ['python3', 'python'];
  }

  const embeddedPython = path.join(appRoot, 'python_runtime', 'python.exe');
  if (fs.existsSync(embeddedPython)) {
    return [embeddedPython];
  }

  const candidates = ['python.exe', 'py.exe'];

  // Add common absolute paths for Windows Python installs
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  // Python Launcher (py.exe) in WindowsApps
  const windowsApps = path.join(localAppData, 'Microsoft', 'WindowsApps');
  candidates.push(path.join(windowsApps, 'python.exe'));
  candidates.push(path.join(windowsApps, 'python3.exe'));

  // Python installed via python.org or Microsoft Store into Local AppData
  try {
    const pythonBase = path.join(localAppData, 'Python');
    if (fs.existsSync(pythonBase)) {
      const entries = fs.readdirSync(pythonBase).filter(e => e.startsWith('pythoncore') || e.startsWith('Python'));
      for (const entry of entries) {
        candidates.push(path.join(pythonBase, entry, 'python.exe'));
      }
    }
  } catch (_) { /* ignore */ }

  // Python installed into Program Files
  const progDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const dir of progDirs) {
    try {
      const entries = fs.readdirSync(dir).filter(e => e.toLowerCase().startsWith('python'));
      for (const entry of entries) {
        candidates.push(path.join(dir, entry, 'python.exe'));
      }
    } catch (_) { /* ignore */ }
  }

  return candidates;
}

async function waitForPort(port, maxAttempts = 10, intervalMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await isPortOpen(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function startServer(server) {
  log(`checking ${server.name} on port ${server.port}`);
  const dataRoot = path.join(app.getPath('userData'), 'data');
  if (await isPortOpen(server.port)) {
    log(`${server.name} already running on port ${server.port}`);
    return;
  }

  if (!fs.existsSync(path.join(server.cwd, 'server.py'))) {
    throw new Error(`Servidor ${server.name} nao encontrado em ${server.cwd}`);
  }

  if (fs.existsSync(server.exe)) {
    const child = spawn(server.exe, [], {
      cwd: server.cwd,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, MONITOR_APP_DIR: server.cwd, MONITOR_DATA_DIR: dataRoot, PORT: String(server.port) }
    });

    log(`spawned ${server.name} with bundled executable`);
    childProcesses.push(child);
    child.on('error', (err) => log(`${server.name} executable error: ${err.message}`));

    if (await waitForPort(server.port, 40, 500)) {
      log(`${server.name} is listening on port ${server.port}`);
      return;
    }
    try { child.kill(); } catch (_) {}
  }

  const candidates = findPythonCommand();
  let lastError = null;

  for (const command of candidates) {
    let child = null;
    let childExited = false;
    let exitCode = null;

    try {
      const args = command === 'py.exe' ? ['-u', '-3', 'server.py'] : ['-u', 'server.py'];
      child = spawn(command, args, {
        cwd: server.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MONITOR_APP_DIR: server.cwd, MONITOR_DATA_DIR: dataRoot, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PORT: String(server.port) }
      });

      log(`spawned ${server.name} with ${command} (PID: ${child.pid})`);
      childProcesses.push(child);

      child.on('error', (err) => {
        lastError = err;
        log(`${server.name} child error (${command}): ${err.message}`);
      });

      child.on('exit', (code) => {
        childExited = true;
        exitCode = code;
        log(`${server.name} child exited with code ${code} (${command})`);
      });

      child.stdout.on('data', (data) => log(`[PYTHON STDOUT] ${data.toString().trim()}`));
      child.stderr.on('data', (data) => log(`[PYTHON STDERR] ${data.toString().trim()}`));

      // Wait up to 30 seconds for the Python HTTP server to initialize and listen
      for (let attempt = 1; attempt <= 60; attempt++) {
        if (childExited) {
          log(`Child process ${command} exited prematurely with code ${exitCode}`);
          break;
        }
        if (await isPortOpen(server.port)) {
          log(`${server.name} is listening on port ${server.port}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (await isPortOpen(server.port)) {
        log(`${server.name} is listening on port ${server.port} (post-wait check)`);
        return;
      }

      if (!childExited) {
        log(`Port ${server.port} did not open after 30s for ${command}. Terminating failed child.`);
        try {
          if (child && child.pid) {
            spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
          }
        } catch (_) {}
      }

    } catch (err) {
      lastError = err;
      if (child && !childExited) {
        try { child.kill(); } catch (_) {}
      }
    }
  }

  if (await isPortOpen(server.port)) {
    log(`${server.name} is listening (detected on final check)`);
    return;
  }

  throw new Error(`Nao foi possivel iniciar ${server.name}. ${lastError ? lastError.message : 'Python nao encontrado.'}`);
}

function findWorkingPython() {
  const candidates = findPythonCommand();
  for (const cmd of candidates) {
    try {
      const result = execSync(`"${cmd}" --version`, {
        windowsHide: true,
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const version = result.toString().trim();
      log(`Found working Python: ${cmd} → ${version}`);
      return { command: cmd, version };
    } catch (_) { /* try next */ }
  }
  return null;
}

function installPythonViaWinget() {
  return new Promise((resolve) => {
    log('Attempting to install Python via winget...');
    
    const child = spawn('winget', ['install', 'Python.Python.3.13', '--accept-source-agreements', '--accept-package-agreements', '--silent'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      log(`winget install finished with code ${code}: ${output.substring(0, 500)}`);
      resolve(code === 0);
    });

    child.on('error', (err) => {
      log(`winget spawn error: ${err.message}`);
      resolve(false);
    });
  });
}

async function ensurePythonInstalled() {
  const python = findWorkingPython();
  if (python) {
    log(`Python OK: ${python.version}`);
    return true;
  }

  log('Python not found on this system');
  
  const response = await dialog.showMessageBox({
    type: 'warning',
    icon: nativeImage.createFromPath(iconPath),
    title: 'Python não encontrado',
    message: 'O Monitores Central precisa do Python para funcionar.',
    detail: 'Python não foi encontrado nesta máquina.\n\nDeseja instalar automaticamente via winget?\n(Isso pode levar alguns minutos)',
    buttons: ['Instalar Python Automaticamente', 'Abrir site do Python', 'Cancelar'],
    defaultId: 0,
    cancelId: 2
  });

  if (response.response === 0) {
    // Install via winget
    const progressWin = new BrowserWindow({
      width: 420,
      height: 180,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      frame: false,
      alwaysOnTop: true,
      transparent: false,
      backgroundColor: '#0f131a',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    progressWin.loadURL(`data:text/html;charset=utf-8,
      <body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0f131a;color:#e2e8f0;font-family:Segoe UI,sans-serif;">
        <div style="font-size:16px;font-weight:700;margin-bottom:12px;">Instalando Python...</div>
        <div style="font-size:12px;color:#8a99ad;">Aguarde, isso pode levar alguns minutos.</div>
        <div style="margin-top:20px;width:200px;height:4px;background:#2b3548;border-radius:2px;overflow:hidden;">
          <div style="width:100%;height:100%;background:linear-gradient(90deg,#6366f1,#818cf8);animation:slide 1.5s infinite;transform-origin:left;"></div>
        </div>
        <style>@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}</style>
      </body>`);

    const success = await installPythonViaWinget();
    progressWin.destroy();

    if (success) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Python instalado!',
        message: 'Python foi instalado com sucesso.',
        detail: 'O aplicativo vai continuar a inicialização normalmente.'
      });
      
      // Verify it actually works now
      const check = findWorkingPython();
      if (check) {
        log(`Python verified after install: ${check.version}`);
        return true;
      }
      
      // winget might need a shell restart for PATH to update
      log('Python installed but not yet in PATH, trying known paths...');
      return true; // findPythonCommand() has hardcoded paths that should find it
    } else {
      const retry = await dialog.showMessageBox({
        type: 'error',
        title: 'Falha na instalação',
        message: 'Não foi possível instalar Python automaticamente.',
        detail: 'Tente instalar manualmente pelo site python.org e reinicie o aplicativo.',
        buttons: ['Abrir site do Python', 'Fechar aplicativo'],
        defaultId: 0
      });
      if (retry.response === 0) {
        shell.openExternal('https://www.python.org/downloads/');
      }
      return false;
    }
  } else if (response.response === 1) {
    shell.openExternal('https://www.python.org/downloads/');
    return false;
  }
  
  return false;
}

async function startServers() {
  log('startServers');
  
  const pythonReady = await ensurePythonInstalled();
  if (!pythonReady) {
    log('Python not available, cannot start servers');
    dialog.showErrorBox('Monitores Central', 'O aplicativo não pode funcionar sem Python instalado.\nInstale Python e reinicie o aplicativo.');
    return;
  }
  
  await ensurePythonDependencies();

  const errors = [];
  for (const server of servers) {
    try {
      await startServer(server);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length > 0) {
    log(`server errors: ${errors.join(' | ')}`);
    dialog.showErrorBox('Falha ao iniciar monitores', errors.join('\n'));
  }
}

function ensurePythonDependencies() {
  return new Promise((resolve) => {
    const commands = findPythonCommand();
    let currentCmdIndex = 0;

    function tryInstall() {
      if (currentCmdIndex >= commands.length) {
        log('All python commands tried, could not verify/install requests');
        resolve();
        return;
      }
      const command = commands[currentCmdIndex];
      log(`Checking/installing requests with command: ${command}`);
      const args = command === 'py.exe' ? ['-3', '-m', 'pip', 'install', 'requests'] : ['-m', 'pip', 'install', 'requests'];
      const child = spawn(command, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      
      child.on('close', (code) => {
        if (code === 0) {
          log(`Successfully verified/installed requests with ${command}`);
          resolve();
        } else {
          log(`pip install failed with code ${code} for ${command}`);
          currentCmdIndex++;
          tryInstall();
        }
      });
      child.on('error', (err) => {
        log(`Failed to run pip check on ${command}: ${err.message}`);
        currentCmdIndex++;
        tryInstall();
      });
    }

    tryInstall();
  });
}

function createWindow() {
  log('createWindow');
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: 'Monitores Central',
    icon: iconPath,
    backgroundColor: '#0f131a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(appRoot, 'desktop', 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(appRoot, 'desktop', 'renderer.html'));
  log(`loaded renderer from ${path.join(appRoot, 'desktop', 'renderer.html')}`);
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    log('window closed');
    mainWindow = null;
  });
}

function configureStartup() {
  if (process.platform !== 'win32') return;

  const isDevOrBuild = !app.isPackaged || process.execPath.includes('dist\\win-unpacked') || process.execPath.includes('Desktop');

  if (isDevOrBuild) {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath
    });
    return;
  }

  // Remove the login entry created by versions that used Electron's default AUMID.
  app.setLoginItemSettings({
    openAtLogin: false,
    name: 'electron.app.Monitores Central'
  });

  app.setLoginItemSettings({
    openAtLogin: true,
    name: 'br.local.monitorescentral',
    path: process.execPath,
    args: ['--background']
  });
}

function createTray() {
  if (tray) return;

  const icon = process.platform === 'win32'
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Monitores Central');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Monitores Central', click: () => createWindow() },
    { type: 'separator' },
    { label: 'Abrir Pedidos no navegador', click: () => shell.openExternal('http://127.0.0.1:8080') },
    { label: 'Abrir Chamados no navegador', click: () => shell.openExternal('http://127.0.0.1:8081') },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', () => createWindow());
}

function killOrphanedServers() {
  if (process.platform !== 'win32') return;
  try {
    log('Killing any orphaned background Python server processes...');
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like \'python%\'\\" | Where-Object { $_.CommandLine -like \'*server.py*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { windowsHide: true });
  } catch (err) {
    log(`killOrphanedServers note: ${err.message}`);
  }
}

function stopChildren() {
  killOrphanedServers();
  for (const child of childProcesses) {
    if (child && !child.killed) {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch (_err) {
        /* ignore */
      }
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} em ${url}`);
  }
  return response.json();
}

function seedSeenNotifications(appKey, notifications) {
  if (!seenNotificationIds.has(appKey)) {
    seenNotificationIds.set(appKey, new Set(notifications.map((item) => item.id).filter(Boolean)));
    return true;
  }
  return false;
}

function shouldNotifyInMainProcess() {
  return !mainWindow || !mainWindow.isVisible();
}

function notificationMatchesPreferences(appKey, item, preferences) {
  if (!preferences || preferences.enableNative !== true) return false;

  if (appKey === 'pedidos') {
    const statusRules = preferences.statusRules || {};
    return statusRules[item.status_atual] !== false;
  }

  const typeRules = {
    novo_chamado: preferences.ruleNew,
    alteracao_status: preferences.ruleStatus,
    nova_resposta: preferences.ruleReply,
    alteracao_categoria: preferences.ruleCategory,
    alteracao_atendente: preferences.ruleAttendant
  };
  if (typeRules[item.tipo] !== true) return false;

  const attendantFilters = preferences.attendantFilters || [];
  const categoryFilters = preferences.categoryFilters || [];
  const attendantName = item.atendente_atual || item.attendantName || '';
  const categoryName = item.categoria_atual || item.categoryName || '';
  const matchesAttendant = attendantFilters.length === 0 || attendantFilters.includes(attendantName);
  const matchesCategory = categoryFilters.length === 0 || categoryFilters.includes(categoryName);
  return matchesAttendant && matchesCategory;
}

async function pollAppNotifications(appKey, titlePrefix, url, preferencesUrl) {
  try {
    const notifications = await fetchJson(url);
    let preferences = { enableNative: false, enableSound: false };
    try {
      preferences = await fetchJson(preferencesUrl);
    } catch (err) {
      log(`notification preferences unavailable (${appKey}): ${err.message}`);
    }
    if (!Array.isArray(notifications)) return;
    if (seedSeenNotifications(appKey, notifications)) return;

    const seen = seenNotificationIds.get(appKey);
    const newItems = notifications
      .filter((item) => item.id && !seen.has(item.id))
      .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

    newItems.forEach((item) => seen.add(item.id));

    if (!shouldNotifyInMainProcess()) return;

    newItems
      .filter((item) => notificationMatchesPreferences(appKey, item, preferences))
      .slice(-5)
      .forEach((item) => {
      const notification = new Notification({
        title: `${titlePrefix} - nova atualização`,
        body: item.mensagem || 'Uma nova alteração foi detectada.',
        silent: preferences.enableSound === false
      });
      notification.on('click', () => createWindow());
      notification.show();
    });
  } catch (err) {
    log(`notification poll error (${appKey}): ${err.message}`);
  }
}

function startNotificationPolling() {
  if (notificationTimer) return;

  const poll = () => {
    pollAppNotifications(
      'pedidos',
      'Pedidos',
      `http://127.0.0.1:${serverPort}/api/pedidos/notificacoes`,
      `http://127.0.0.1:${serverPort}/api/pedidos/preferencias`
    );
    pollAppNotifications(
      'chamados',
      'Chamados',
      `http://127.0.0.1:${serverPort}/api/chamados/notificacoes`,
      `http://127.0.0.1:${serverPort}/api/chamados/preferencias`
    );
  };

  setTimeout(poll, 6000);
  notificationTimer = setInterval(poll, 30000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const background = argv.includes('--background');
    if (!background) {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    log(`ready; packaged=${app.isPackaged}; argv=${process.argv.join(' ')}; appRoot=${appRoot}`);
    try {
      serverPort = await getFreePort();
      servers[0].port = serverPort;
      servers[0].url = `http://127.0.0.1:${serverPort}`;
      log(`Assigned dynamic port: ${serverPort}`);
    } catch (err) {
      log(`Failed to get free port: ${err.message}. Using default 8080.`);
    }
    killOrphanedServers();
    configureStartup();
    createTray();
    await startServers();
    startNotificationPolling();
    if (!isBackgroundStart) {
      createWindow();
    } else {
      log('background start; tray only');
    }
  }).catch((err) => {
    log(`ready error: ${err.stack || err.message}`);
  });
}

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform === 'darwin') {
    return;
  }
  if (isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('before-quit');
  isQuitting = true;
  stopChildren();
});

app.on('activate', () => {
  createWindow();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

ipcMain.handle('select-file', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || []
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('save-file', async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options?.defaultPath || '',
    filters: options?.filters || []
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
});

ipcMain.handle('run-tool', async (_event, toolName, args) => {
  const allowedTools = new Set(['processar_planilha.py', 'csv_repair_tool.py', 'divisor.py']);
  if (!allowedTools.has(toolName)) {
    return { success: false, code: -1, error: 'Ferramenta inválida.' };
  }
  const scriptPath = path.join(appRoot, 'tools', toolName);
  const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
  if (!fs.existsSync(scriptPath)) {
    return { success: false, code: -1, error: `Script não encontrado: ${scriptPath}` };
  }
  if (normalizedArgs[0] && !fs.existsSync(normalizedArgs[0])) {
    return { success: false, code: -1, error: `Arquivo de entrada não encontrado: ${normalizedArgs[0]}` };
  }

  for (const command of findPythonCommand()) {
    const isLauncher = path.basename(command).toLowerCase() === 'py.exe';
    const spawnArgs = isLauncher ? ['-3', '-u', scriptPath, ...normalizedArgs] : ['-u', scriptPath, ...normalizedArgs];
    log(`Running tool ${toolName}: ${JSON.stringify([command, ...spawnArgs])}`);
    const result = await new Promise((resolve) => {
      let child;
      let spawnFailed = false;
      try {
        child = spawn(command, spawnArgs, {
          cwd: path.dirname(scriptPath),
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            MONITOR_APP_DIR: appRoot,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1'
          }
        });
      } catch (error) {
        resolve({ spawnFailed: true, error: error.message });
        return;
      }

      childProcesses.push(child);
      const timeout = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tool-output', '\n[ERRO] Tempo limite de 30 minutos excedido.\n');
        }
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
      }, 30 * 60 * 1000);

      const sendOutput = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tool-output', data.toString('utf8'));
        }
      };
      child.stdout.on('data', sendOutput);
      child.stderr.on('data', sendOutput);
      child.once('error', (error) => {
        spawnFailed = true;
        clearTimeout(timeout);
        log(`Failed to spawn tool with ${command}: ${error.message}`);
        resolve({ spawnFailed: true, error: error.message });
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        const index = childProcesses.indexOf(child);
        if (index >= 0) childProcesses.splice(index, 1);
        if (spawnFailed) return;
        log(`Tool ${toolName} finished with code ${code}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tool-close', code);
        }
        resolve({ spawnFailed: false, success: code === 0, code, error: code === 0 ? null : `O script terminou com código ${code}.` });
      });
    });
    if (!result.spawnFailed) return result;
  }
  return { success: false, code: -1, error: 'Não foi possível iniciar o Python.' };
});

ipcMain.handle('get-server-port', () => {
  return serverPort;
});
