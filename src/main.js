const { app, BrowserWindow, BrowserView, shell, session, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, nativeTheme, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { execFile, spawn, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

process.on('uncaughtException', (err) => {
  console.error('[Pigeon Main Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Pigeon Main Unhandled Rejection]:', reason);
});

// Принудительный тёмный режим на уровне движка Chromium
nativeTheme.themeSource = 'dark';
app.commandLine.appendSwitch('force-dark-mode');
app.commandLine.appendSwitch('blink-settings', 'darkMode=4');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Временный локальный канал диагностики DOM. Слушает только localhost и нужен,
// чтобы сопоставить интеграции Pigeon с текущей разметкой XChat.
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', '9223');

const defaultTrayIconPath = path.join(__dirname, '../assets/tray.png');
const appIconPath = path.join(__dirname, '../assets/icon.png');
const badgesDir = path.join(__dirname, '../assets/tray_badges');
const soundsDir = path.join(__dirname, '../assets/sounds');

const MAIN_DUPLICATE_WINDOW_MS = 500;
const MAIN_REPLACE_WINDOW_MS = 25000;

const MEDIA_LABELS = {
  ru: {
    photo: '📷 Фотография',
    video: '📹 Видео',
    voice: '🎤 Голосовое сообщение',
    call: '📞 Входящий звонок',
    gif: '👾 GIF',
    file: '📎 Файл'
  },
  en: {
    photo: '📷 Photo',
    video: '📹 Video',
    voice: '🎤 Voice message',
    call: '📞 Incoming call',
    gif: '👾 GIF',
    file: '📎 File'
  }
};

const avatarsCacheDir = path.join(app.getPath('temp'), 'pigeon_avatars');
if (!fs.existsSync(avatarsCacheDir)) {
  fs.mkdirSync(avatarsCacheDir, { recursive: true });
}

// Извлекаем иконку приложения на реальный диск вне ASAR, чтобы Windows Action Center мог её прочитать
const extractedAppIconPath = path.join(avatarsCacheDir, 'app_icon.png');
function ensureExtractedIcon() {
  try {
    if (!fs.existsSync(extractedAppIconPath) && fs.existsSync(appIconPath)) {
      fs.writeFileSync(extractedAppIconPath, fs.readFileSync(appIconPath));
    }
  } catch (e) {}
}
ensureExtractedIcon();

function getFallbackIconPath() {
  ensureExtractedIcon();
  return fs.existsSync(extractedAppIconPath) ? extractedAppIconPath : appIconPath;
}

async function fetchAvatar(avatarUrl) {
  const fallback = getFallbackIconPath();
  if (!avatarUrl || typeof avatarUrl !== 'string' || !avatarUrl.startsWith('http')) {
    return fallback;
  }

  try {
    const parsed = new URL(avatarUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }
  } catch (e) {
    return fallback;
  }

  const hash = crypto.createHash('md5').update(avatarUrl).digest('hex');
  const ext = avatarUrl.includes('.png') ? '.png' : '.jpg';
  const filePath = path.join(avatarsCacheDir, `${hash}${ext}`);

  if (fs.existsSync(filePath)) {
    return filePath;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(avatarUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return fallback;

    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > 5 * 1024 * 1024) {
      console.warn(`[Pigeon Main] ⚠️ Размер аватарки превышает 5 МБ: ${avatarUrl}`);
      return fallback;
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
      return fallback;
    }

    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    console.log(`[Pigeon Main] 🖼️ Аватарка успешно скачана: ${filePath}`);
    return filePath;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[Pigeon Main] Ошибка скачивания аватарки:', err.message || err);
    return fallback;
  }
}

// Привязываем имя приложения для Wayland, Windows и оконных менеджеров
app.setName('Pigeon');
if (process.platform === 'linux') {
  app.setDesktopName('pigeon');
  // Нативная поддержка Wayland для Hyprland и звонков WebRTC
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,WebRTCPipeWireCapturer,CanvasOopRasterization');
} else if (process.platform === 'win32') {
  app.setAppUserModelId('com.pigeon.xchat');
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const configPath = path.join(app.getPath('userData'), 'pigeon_config.json');
const performanceLogPath = path.join(app.getPath('userData'), 'pigeon_renderer_performance.jsonl');
const cpuProfilePath = path.join(app.getPath('userData'), 'pigeon_renderer_cpu_profile.json');
const wallpaperDir = path.join(app.getPath('userData'), 'wallpapers');
const bundledWallpapersDir = path.join(__dirname, '../assets/wallpapers');
const BUNDLED_CHAT_WALLPAPERS = Object.freeze({
  celestial: 'celestial-pattern.webp',
  playful: 'playful-pattern.webp',
  galaxy: 'galaxy.webp',
  forest: 'forest.webp',
  'neon-city': 'neon-city.webp',
  'neon-blur': 'neon-blur.webp',
  'purple-lake': 'purple-lake.webp',
  coffee: 'coffee.webp'
});
const CHAT_WALLPAPER_IDS = new Set(['none', ...Object.keys(BUNDLED_CHAT_WALLPAPERS), 'custom']);
const CHAT_WALLPAPER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_CHAT_WALLPAPER_BYTES = 12 * 1024 * 1024;
// Профилирование включается только во время отдельной диагностики: DevTools
// sampler не должен работать у пользователя во время обычной переписки.
const ENABLE_RENDERER_PROFILING = false;
let activeRendererCpuProfile = null;
let rendererCpuProfileTimeout = null;

async function stopRendererCpuProfile() {
  const session = activeRendererCpuProfile;
  activeRendererCpuProfile = null;
  if (rendererCpuProfileTimeout) {
    clearTimeout(rendererCpuProfileTimeout);
    rendererCpuProfileTimeout = null;
  }
  if (!session || session.webContents.isDestroyed()) return;

  try {
    const result = await session.webContents.debugger.sendCommand('Profiler.stop');
    await session.webContents.debugger.sendCommand('Profiler.disable');
    if (session.webContents.debugger.isAttached()) session.webContents.debugger.detach();
    // Профиль содержит только имена JS-функций и их время выполнения; текст,
    // адреса и содержимое переписки в него не записываются.
    fs.writeFile(cpuProfilePath, JSON.stringify({
      capturedAt: Date.now(),
      durationMs: Date.now() - session.startedAt,
      profile: result.profile
    }), () => {});
  } catch (error) {
    try {
      if (session.webContents.debugger.isAttached()) session.webContents.debugger.detach();
    } catch (e) {}
    console.warn('[Pigeon Performance] Не удалось завершить CPU-профиль:', error.message || error);
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data) {
        return {
          language: (data.language === 'ru' || data.language === 'en') ? data.language : 'en',
          notificationsEnabled: data.notificationsEnabled !== false,
          soundEnabled: data.soundEnabled !== false,
          soundFile: data.soundFile || 'come here.mp3',
          autoStart: data.autoStart !== false,
          // Сетевой Ghost Mode ломает составные GraphQL-мутации XChat:
          // отправка сообщения и last-seen могут находиться в одном запросе.
          ghostMode: false,
          privacyBlur: data.privacyBlur === true,
          bossKeyEnabled: data.bossKeyEnabled !== false,
          reducedMotion: data.reducedMotion === true,
          chatWallpaper: CHAT_WALLPAPER_IDS.has(data.chatWallpaper) ? data.chatWallpaper : 'none',
          chatWallpaperDim: Number.isFinite(Number(data.chatWallpaperDim))
            ? Math.max(0, Math.min(Number(data.chatWallpaperDim), 75))
            : 36,
          chatWallpaperBlur: Number.isFinite(Number(data.chatWallpaperBlur))
            ? Math.max(0, Math.min(Number(data.chatWallpaperBlur), 12))
            : 0,
          chatWallpaperCustomPath: typeof data.chatWallpaperCustomPath === 'string' ? data.chatWallpaperCustomPath : ''
        };
      }
    }
  } catch (e) {}
  return {
    language: 'en',
    notificationsEnabled: true,
    soundEnabled: true,
    soundFile: 'come here.mp3',
    autoStart: true,
    ghostMode: false,
    privacyBlur: false,
    bossKeyEnabled: true,
    reducedMotion: false,
    chatWallpaper: 'none',
    chatWallpaperDim: 36,
    chatWallpaperBlur: 0,
    chatWallpaperCustomPath: ''
  };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {}
}

const appConfig = loadConfig();

function getCustomWallpaperDataUrl() {
  try {
    if (!appConfig.chatWallpaperCustomPath) return '';
    const resolvedPath = path.resolve(appConfig.chatWallpaperCustomPath);
    const resolvedDir = path.resolve(wallpaperDir);
    const extension = path.extname(resolvedPath).toLowerCase();
    if (path.dirname(resolvedPath) !== resolvedDir || !CHAT_WALLPAPER_EXTENSIONS.has(extension)) return '';
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size > MAX_CHAT_WALLPAPER_BYTES) return '';
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(resolvedPath).toString('base64')}`;
  } catch (e) {
    return '';
  }
}

function getBundledWallpaperDataUrl(id) {
  try {
    const fileName = BUNDLED_CHAT_WALLPAPERS[id];
    if (!fileName) return '';
    const filePath = path.join(bundledWallpapersDir, fileName);
    return `data:image/webp;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch (e) {
    return '';
  }
}

function getSelectedWallpaperDataUrl() {
  return appConfig.chatWallpaper === 'custom'
    ? getCustomWallpaperDataUrl()
    : getBundledWallpaperDataUrl(appConfig.chatWallpaper);
}

function getRendererSettings(includeWallpaperData = false) {
  const { chatWallpaperCustomPath, ...safeConfig } = appConfig;
  const settings = {
    ...safeConfig,
    sounds: AVAILABLE_SOUNDS,
    isWindows: process.platform === 'win32',
    isLinux: process.platform === 'linux'
  };
  if (includeWallpaperData) settings.chatWallpaperDataUrl = getSelectedWallpaperDataUrl();
  return settings;
}

const AVAILABLE_SOUNDS = [
  { id: 'come here.mp3', nameEn: 'Come Here (Default)', nameRu: 'Come Here (По умолчанию)' },
  { id: 'telegram sound.mp3', nameEn: 'Telegram', nameRu: 'Telegram' },
  { id: 'vkontakte sound.mp3', nameEn: 'VKontakte', nameRu: 'ВКонтакте' },
  { id: 'chitter.mp3', nameEn: 'Chitter', nameRu: 'Chitter' },
  { id: 'ding.mp3', nameEn: 'Ding', nameRu: 'Ding' },
  { id: 'juntos.mp3', nameEn: 'Juntos', nameRu: 'Juntos' },
  { id: 'pull out.mp3', nameEn: 'Pull Out', nameRu: 'Pull Out' },
  { id: 'slick.mp3', nameEn: 'Slick', nameRu: 'Slick' },
  { id: 'sly.mp3', nameEn: 'Sly', nameRu: 'Sly' },
  { id: 'soobschenie.mp3', nameEn: 'Soobschenie', nameRu: 'Сообщение' }
];

const ALLOWED_SOUND_IDS = new Set(AVAILABLE_SOUNDS.map(s => s.id));

function isSafeSoundFile(file) {
  return typeof file === 'string' && ALLOWED_SOUND_IDS.has(file);
}

const soundDataUriCache = new Map();
function getSoundDataUri(soundPath) {
  if (soundDataUriCache.has(soundPath)) {
    return soundDataUriCache.get(soundPath);
  }
  try {
    const buffer = fs.readFileSync(soundPath);
    const dataUri = `data:audio/mp3;base64,${buffer.toString('base64')}`;
    soundDataUriCache.set(soundPath, dataUri);
    return dataUri;
  } catch (err) {
    console.error('[Pigeon Audio] Ошибка чтения аудиофайла:', err);
    return null;
  }
}

let soundWindow = null;

function getOrCreateSoundWindow() {
  try {
    if (soundWindow && !soundWindow.isDestroyed()) {
      return soundWindow;
    }
    soundWindow = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
        preload: path.join(__dirname, 'sound-preload.js')
      }
    });

    soundWindow.webContents.on('render-process-gone', (_event, details) => {
      console.warn('[Pigeon Audio] soundWindow process gone:', details);
      try {
        soundWindow.destroy();
      } catch (e) {}
      soundWindow = null;
    });

    soundWindow.loadFile(path.join(__dirname, 'sound.html'));
    return soundWindow;
  } catch (err) {
    console.error('[Pigeon Audio] ❌ Ошибка создания soundWindow:', err);
    return null;
  }
}

function playSoundDirect(soundPath) {
  const dataUri = getSoundDataUri(soundPath);
  if (!dataUri) return;

  const win = getOrCreateSoundWindow();
  if (win && !win.isDestroyed()) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        try {
          win.webContents.send('play-sound', dataUri);
        } catch (e) {
          playSoundInRenderer(soundPath);
        }
      });
    } else {
      try {
        win.webContents.send('play-sound', dataUri);
      } catch (e) {
        playSoundInRenderer(soundPath);
      }
    }
  } else {
    playSoundInRenderer(soundPath);
  }
}

function playSoundInRenderer(soundPath) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const dataUri = getSoundDataUri(soundPath);
      if (dataUri) {
        mainWindow.webContents.send('play-sound-in-renderer', dataUri);
      }
    }
  } catch (err) {
    console.error('[Pigeon Audio] Ошибка playSoundInRenderer:', err);
  }
}

function playNotificationSound(soundFileName = null, force = false) {
  if (!force && (!appConfig.notificationsEnabled || !appConfig.soundEnabled)) return;

  const fileName = soundFileName || appConfig.soundFile || 'come here.mp3';
  if (!isSafeSoundFile(fileName)) {
    console.warn(`[Pigeon Audio] ⚠️ Попытка воспроизвести неразрешенный звуковой файл: ${fileName}`);
    return;
  }

  const soundPath = path.join(soundsDir, fileName);

  if (!fs.existsSync(soundPath)) {
    console.warn(`[Pigeon Audio] Sound file not found: ${soundPath}`);
    return;
  }

  console.log(`[Pigeon Audio] 🔊 Воспроизведение звука: ${fileName} (force=${force})`);

  // Прямое воспроизведение через изолированный аудио-движок Electron на всех платформах (Windows, Linux, macOS)
  playSoundDirect(soundPath);
}

function broadcastSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-sync', getRendererSettings());
  }
}

function setNotificationsEnabled(enabled) {
  appConfig.notificationsEnabled = Boolean(enabled);
  if (enabled) {
    appConfig.soundEnabled = true;
  }
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🔔 Всплывающие уведомления со звуком: ${appConfig.notificationsEnabled ? 'ВКЛ' : 'ВЫКЛ'}`);
  updateTrayMenu();
  broadcastSettings();
}

function setSoundEnabled(enabled) {
  appConfig.soundEnabled = Boolean(enabled);
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🔊 Звук уведомлений: ${appConfig.soundEnabled ? 'ВКЛ' : 'ВЫКЛ'}`);
  updateTrayMenu();
  broadcastSettings();
}

function setSoundFile(file) {
  if (!isSafeSoundFile(file)) {
    console.warn(`[Pigeon Main] ⚠️ Недопустимый звуковой файл: ${file}`);
    return;
  }
  appConfig.soundFile = file;
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🎵 Выбран звук уведомлений: ${appConfig.soundFile}`);
  updateTrayMenu();
  broadcastSettings();
}

function setAutoStart(enabled) {
  appConfig.autoStart = Boolean(enabled);
  saveConfig(appConfig);
  if (process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: process.execPath,
        args: ['--hidden']
      });
      console.log(`[Pigeon Main] 🚀 Автозапуск Windows: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    } catch (err) {
      console.error('[Pigeon Main] ❌ Ошибка настройки автозапуска Windows:', err);
    }
    // До v0.1.0 инсталлятор создавал отдельную запись Run. Удаляем её при
    // выключении, чтобы настройка действительно останавливала автозапуск.
    if (!enabled) {
      execFile('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Pigeon', '/f'], {
        windowsHide: true
      }, () => {});
    }
  } else if (process.platform === 'linux') {
    try {
      syncLinuxAutoStart(Boolean(enabled));
      console.log(`[Pigeon Main] 🚀 Автозапуск Linux: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    } catch (err) {
      console.error('[Pigeon Main] ❌ Ошибка настройки автозапуска Linux:', err);
    }
  }
  broadcastSettings();
}

function getLinuxAutoStartPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
  return path.join(configHome, 'autostart', 'pigeon.desktop');
}

function escapeDesktopEntryArgument(value) {
  return String(value).replace(/([\\"])/g, '\\$1');
}

function syncLinuxAutoStart(enabled) {
  const desktopPath = getLinuxAutoStartPath();
  if (!enabled) {
    if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
    return;
  }

  const execPath = escapeDesktopEntryArgument(process.execPath);
  const appArgument = app.isPackaged ? '' : ` \"${escapeDesktopEntryArgument(app.getAppPath())}\"`;
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Pigeon',
    `Exec=\"${execPath}\"${appArgument} --hidden`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n') + '\n';

  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(desktopPath, desktopEntry, 'utf8');
}

function setGhostMode(enabled) {
  // Оставлен для совместимости со старыми конфигами/IPC, но больше не
  // вмешивается в транспорт XChat: это вызывало повторные отправки сообщений.
  appConfig.ghostMode = false;
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 👻 Режим невидимки (Ghost Mode): ${appConfig.ghostMode ? 'ВКЛ' : 'ВЫКЛ'}`);
  updateTrayMenu();
  broadcastSettings();
}

function setPrivacyBlur(enabled) {
  appConfig.privacyBlur = Boolean(enabled);
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🕶️ Размытие сообщений (Privacy Blur): ${appConfig.privacyBlur ? 'ВКЛ' : 'ВЫКЛ'}`);
  updateTrayMenu();
  broadcastSettings();
}

function setBossKeyEnabled(enabled) {
  appConfig.bossKeyEnabled = Boolean(enabled);
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🚨 Boss Key: ${appConfig.bossKeyEnabled ? 'ВКЛ' : 'ВЫКЛ'}`);
  updateTrayMenu();
  broadcastSettings();
}

function setReducedMotion(enabled) {
  appConfig.reducedMotion = Boolean(enabled);
  saveConfig(appConfig);
  console.log(`[Pigeon Main] ✨ Уменьшение анимаций: ${appConfig.reducedMotion ? 'ВКЛ' : 'ВЫКЛ'}`);
  broadcastSettings();
}

function setChatWallpaper(settings = {}) {
  const requestedId = typeof settings.id === 'string' ? settings.id : appConfig.chatWallpaper;
  const wallpaperId = CHAT_WALLPAPER_IDS.has(requestedId) ? requestedId : 'none';
  appConfig.chatWallpaper = wallpaperId === 'custom' && !getCustomWallpaperDataUrl() ? 'none' : wallpaperId;

  if (Number.isFinite(Number(settings.dim))) {
    appConfig.chatWallpaperDim = Math.max(0, Math.min(Math.round(Number(settings.dim)), 75));
  }
  if (Number.isFinite(Number(settings.blur))) {
    appConfig.chatWallpaperBlur = Math.max(0, Math.min(Math.round(Number(settings.blur)), 12));
  }

  saveConfig(appConfig);
  broadcastSettings();
}

function triggerBossKey() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    console.log('[Pigeon Main] 🚨 Boss Key: окно скрыто в трей');
    mainWindow.hide();
  } else {
    console.log('[Pigeon Main] 🚨 Boss Key: окно открыто');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let currentUnread = 0;
let updaterInitialized = false;
let automaticUpdateCheckScheduled = false;
let updateInstallRequested = false;
let dismissedUpdateVersion = '';
let appUpdateState = { status: 'idle', currentVersion: app.getVersion() };

function sendAppUpdateState(nextState = appUpdateState) {
  appUpdateState = { ...appUpdateState, ...nextState, currentVersion: app.getVersion(), language: appConfig.language };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app-update-state', appUpdateState);
  }
}

function getSafeUpdateError(error) {
  const message = String(error?.message || error || 'Update failed');
  return message.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function initializeAutoUpdater() {
  if (updaterInitialized || !app.isPackaged || !['win32', 'linux'].includes(process.platform)) return;
  updaterInitialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    appUpdateState = { status: 'checking', currentVersion: app.getVersion() };
  });
  autoUpdater.on('update-available', info => {
    const version = String(info?.version || '');
    if (version && version === dismissedUpdateVersion) return;
    sendAppUpdateState({ status: 'available', version, percent: 0, error: '' });
  });
  autoUpdater.on('update-not-available', () => {
    appUpdateState = { status: 'idle', currentVersion: app.getVersion() };
  });
  autoUpdater.on('download-progress', progress => {
    sendAppUpdateState({
      status: 'downloading',
      version: appUpdateState.version || '',
      percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
      transferred: Math.max(0, Number(progress?.transferred) || 0),
      total: Math.max(0, Number(progress?.total) || 0)
    });
  });
  autoUpdater.on('update-downloaded', info => {
    sendAppUpdateState({ status: 'downloaded', version: String(info?.version || appUpdateState.version || ''), percent: 100 });
    if (updateInstallRequested) {
      setTimeout(() => {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      }, 900);
    }
  });
  autoUpdater.on('error', error => {
    console.warn('[Pigeon Updater] Update error:', getSafeUpdateError(error));
    if (updateInstallRequested) {
      sendAppUpdateState({ status: 'error', error: getSafeUpdateError(error) });
    } else {
      appUpdateState = { status: 'idle', currentVersion: app.getVersion() };
    }
  });
}

function scheduleAutomaticUpdateCheck() {
  if (automaticUpdateCheckScheduled) return;
  automaticUpdateCheckScheduled = true;
  setTimeout(() => {
    initializeAutoUpdater();
    if (!updaterInitialized) return;
    autoUpdater.checkForUpdates().catch(error => {
      console.warn('[Pigeon Updater] Background check failed:', getSafeUpdateError(error));
    });
  }, 3500);
}

function getTelegramTrayIcon(count) {
  if (count <= 0) {
    return defaultTrayIconPath;
  }
  if (count === 1) return path.join(badgesDir, 'tray_1.png');
  if (count === 2) return path.join(badgesDir, 'tray_2.png');
  if (count === 3) return path.join(badgesDir, 'tray_3.png');
  if (count === 4) return path.join(badgesDir, 'tray_4.png');
  if (count === 5) return path.join(badgesDir, 'tray_5.png');
  if (count > 5) return path.join(badgesDir, 'tray_plus.png');
  return path.join(badgesDir, 'tray_dot.png');
}

function setTrayState(unreadCount) {
  if (!tray) return;

  currentUnread = unreadCount;
  const iconPath = getTelegramTrayIcon(unreadCount);
  tray.setImage(nativeImage.createFromPath(iconPath));

  const isRu = appConfig.language === 'ru';
  if (unreadCount > 0) {
    tray.setToolTip(isRu ? `Pigeon — ${unreadCount} непрочитанных (XChat)` : `Pigeon — ${unreadCount} unread (XChat)`);
  } else {
    tray.setToolTip('Pigeon — XChat');
  }

  if (process.platform === 'linux' || process.platform === 'darwin') {
    app.setBadgeCount(unreadCount);
  } else if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    if (unreadCount > 0) {
      mainWindow.setOverlayIcon(nativeImage.createFromPath(iconPath), `${unreadCount} unread`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }
}

let activeNotifications = new Map(); // notifId -> { child, convId }
const activeElectronNotifications = new Set();
const lastNotifiedInMain = new Map(); // convKey -> { body, time, notifId }

// Очистка устаревших записей каждые 10 минут (защита от утечки памяти)
setInterval(() => {
  const cutoff = Date.now() - 3600000; // 1 час
  for (const [key, val] of lastNotifiedInMain) {
    if (val.time < cutoff) lastNotifiedInMain.delete(key);
  }
}, 600000);

let toastWindow = null;
let toastTimeout = null;
let currentToastConvId = null;
let toastDeadline = 0;
let toastRemaining = 0;
let toastPaused = false;
const TOAST_DURATION_MS = 5500;

function hideDesktopToast() {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = null;
  toastRemaining = 0;
  toastDeadline = 0;
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.webContents.send('hide-toast');
    setTimeout(() => {
      if (toastWindow && !toastWindow.isDestroyed() && !toastPaused) toastWindow.hide();
    }, 300);
  }
}

function scheduleDesktopToastHide(delay = TOAST_DURATION_MS) {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastRemaining = Math.max(0, delay);
  toastDeadline = Date.now() + toastRemaining;
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.webContents.send('set-toast-progress', { duration: toastRemaining });
  }
  toastTimeout = setTimeout(hideDesktopToast, toastRemaining);
}

function getToastWorkArea() {
  const { screen } = require('electron');
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds())?.workArea;
  }
  return screen.getPrimaryDisplay()?.workArea;
}

function getOrCreateToastWindow() {
  if (toastWindow && !toastWindow.isDestroyed()) {
    return toastWindow;
  }
  try {
    const workArea = getToastWorkArea() || { x: 0, y: 0, width: 1920, height: 1080 };
    const width = 360;
    const height = 86;
    const margin = 16;
    const x = Math.round(workArea.x + workArea.width - width - margin);
    const y = Math.round(workArea.y + workArea.height - height - margin);

    toastWindow = new BrowserWindow({
      width: width,
      height: height,
      x: x,
      y: y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
        preload: path.join(__dirname, 'toast-preload.js')
      }
    });

    toastWindow.setAlwaysOnTop(true, 'screen-saver');
    toastWindow.setVisibleOnAllWorkspaces(true);
    toastWindow.loadFile(path.join(__dirname, 'toast.html'));
    return toastWindow;
  } catch (err) {
    console.error('[Pigeon Main] ❌ Ошибка создания toastWindow:', err);
    return null;
  }
}

function showDesktopToastPopup(title, body, customIcon = null, convId = null) {
  try {
    const workArea = getToastWorkArea();
    if (!workArea) return;

    const width = 360;
    const height = 86;
    const margin = 16;
    const x = Math.round(workArea.x + workArea.width - width - margin);
    const y = Math.round(workArea.y + workArea.height - height - margin);

    currentToastConvId = convId;
    toastPaused = false;

    const win = getOrCreateToastWindow();
    if (!win) return;
    win.setPosition(x, y);

    let avatarBase64 = null;
    if (customIcon && fs.existsSync(customIcon)) {
      try {
        const ext = customIcon.endsWith('.png') ? 'png' : 'jpeg';
        const b64 = fs.readFileSync(customIcon).toString('base64');
        avatarBase64 = `data:image/${ext};base64,${b64}`;
      } catch (e) {}
    }

    const payload = {
      title: title || 'Pigeon',
      body: body || '',
      avatarBase64: avatarBase64,
      reducedMotion: appConfig.reducedMotion === true
    };

    const sendUpdate = () => {
      if (toastWindow && !toastWindow.isDestroyed()) {
        toastWindow.webContents.send('update-toast', payload);
        toastWindow.webContents.send('set-toast-progress', { duration: toastRemaining || TOAST_DURATION_MS });
        toastWindow.showInactive();
      }
    };

    if (toastWindow.webContents.isLoading()) {
      toastWindow.webContents.once('did-finish-load', sendUpdate);
    } else {
      sendUpdate();
    }

    scheduleDesktopToastHide();
  } catch (err) {
    console.error('[Pigeon Main] ❌ Ошибка показа плавающего тоста:', err);
  }
}

function dismissAllNotifications() {
  toastPaused = false;
  hideDesktopToast();

  for (const notif of activeElectronNotifications) {
    try { notif.close(); } catch (e) {}
  }
  activeElectronNotifications.clear();

  if (activeNotifications.size === 0) return;
  const entries = Array.from(activeNotifications.entries());
  activeNotifications.clear();

  entries.forEach(([id, item]) => {
    const child = item?.child || item;
    if (child) {
      try { child.kill('SIGTERM'); } catch (e) {}
    }
    if (id) {
      execFile('gdbus', [
        'call',
        '--session',
        '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.CloseNotification',
        id.toString()
      ], () => {});
    }
  });
}

function dismissNotificationByConvId(targetConvId, specificNid = null, specificChild = null) {
  if (toastWindow && !toastWindow.isDestroyed() && currentToastConvId === targetConvId) {
    toastPaused = false;
    hideDesktopToast();
  }

  if (specificChild) {
    try { specificChild.kill('SIGTERM'); } catch (e) {}
  }
  if (specificNid) {
    execFile('gdbus', [
      'call',
      '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.CloseNotification',
      specificNid.toString()
    ], () => {});
    activeNotifications.delete(specificNid);
  }
  if (targetConvId) {
    for (const [id, item] of activeNotifications.entries()) {
      if (item && item.convId === targetConvId) {
        if (item.child) {
          try { item.child.kill('SIGTERM'); } catch (e) {}
        }
        if (id) {
          execFile('gdbus', [
            'call',
            '--session',
            '--dest', 'org.freedesktop.Notifications',
            '--object-path', '/org/freedesktop/Notifications',
            '--method', 'org.freedesktop.Notifications.CloseNotification',
            id.toString()
          ], () => {});
        }
        activeNotifications.delete(id);
      }
    }
    for (const notif of activeElectronNotifications) {
      if (notif && notif.convId === targetConvId) {
        try { notif.close(); } catch (e) {}
        activeElectronNotifications.delete(notif);
      }
    }
  }
}

function isTypingIndicator(str) {
  if (!str) return false;
  const s = str.trim().toLowerCase();
  if (/^(печатает|typing|is typing|набирает|набирает сообщение)[\.\s…]*$/i.test(s)) return true;
  if (s.startsWith('печатает') || s.startsWith('typing') || s.includes('is typing') || s.startsWith('набирает')) return true;
  return false;
}

function sendDesktopNotification(convId, title, body, customIcon = null, mediaType = null) {
  // Обратная совместимость, если вызвана как (title, body, customIcon)
  if (arguments.length <= 3 && customIcon === null && typeof convId === 'string' && typeof title === 'string' && typeof body !== 'string') {
    customIcon = body;
    body = title;
    title = convId;
    convId = null;
  }

  const isRu = (appConfig.language || 'en') === 'ru';
  const lang = isRu ? 'ru' : 'en';

  const defaultTitle = isRu ? 'Новое сообщение' : 'New message';
  const defaultBody = isRu ? 'Вам пришло сообщение в XChat' : 'You received a message in XChat';
  const readAction = isRu ? 'read=Прочитать' : 'read=Mark as read';
  const openAction = isRu ? 'default=Открыть' : 'default=Open';

  const notifTitle = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 150) : defaultTitle;

  let formattedBody = (typeof body === 'string') ? body.trim() : '';

  // Если тело пустое или общее заглушечное, подставляем локализованный медиа-лейбл
  if (!formattedBody || formattedBody === 'Новое сообщение' || formattedBody === 'New message') {
    if (mediaType && MEDIA_LABELS[lang] && MEDIA_LABELS[lang][mediaType]) {
      formattedBody = MEDIA_LABELS[lang][mediaType];
    } else if (!formattedBody) {
      formattedBody = defaultBody;
    }
  }
  const notifBody = formattedBody.slice(0, 500);

  // Игнорируем статусы "Печатает..."
  if (isTypingIndicator(notifBody)) {
    console.log(`[Pigeon Main] ⏳ Игнорирован статус набора текста: "${notifBody}"`);
    return;
  }

  const convKey = convId || notifTitle;
  const now = Date.now();
  const prev = lastNotifiedInMain.get(convKey);

  // Защита от точных дублей в главном процессе в пределах MAIN_DUPLICATE_WINDOW_MS (6000ms)
  if (prev && prev.body === notifBody && (now - prev.time < MAIN_DUPLICATE_WINDOW_MS)) {
    console.log(`[Pigeon Main] 🛡️ Игнорирован дубликат уведомления от "${convKey}": "${notifBody}"`);
    return;
  }

  let icon = getFallbackIconPath();
  if (customIcon && fs.existsSync(customIcon)) {
    icon = customIcon;
  }

  console.log(`[Pigeon Main] 🚀 Отправка всплывающего уведомления [${convKey}]: [${notifTitle}] "${notifBody}" (иконка: ${icon})`);

  // Воспроизведение звука: каждое всплывающее уведомление сопровождается звуком (1 уведомление = 1 звук)
  playNotificationSound();

  function showElectronNotificationFallback() {
    try {
      if (process.platform === 'win32') {
        showDesktopToastPopup(notifTitle, notifBody, icon, convId);
      }

      if (Notification.isSupported()) {
        console.log(`[Pigeon Main] 📬 Electron Notification API: [${notifTitle}] "${notifBody}"`);
        const notifOptions = {
          title: notifTitle,
          body: notifBody,
          silent: true // Pigeon сам воспроизводит настроенный пользователем звук
        };

        if (icon && fs.existsSync(icon)) {
          notifOptions.icon = icon;
        }

        const notif = new Notification(notifOptions);
        notif.convId = convId;

        activeElectronNotifications.add(notif);
        notif.on('close', () => activeElectronNotifications.delete(notif));

        notif.on('click', () => {
          activeElectronNotifications.delete(notif);
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
            if (convId) {
              mainWindow.webContents.send('open-conversation', convId);
            }
          }
        });

        notif.on('failed', (_event, error) => {
          console.error('[Pigeon Main] ❌ Ошибка показа системного уведомления Windows:', error);
        });

        notif.show();
        lastNotifiedInMain.set(convKey, { body: notifBody, time: now, notifId: null });
      } else {
        console.warn('[Pigeon Main] ⚠️ Notification.isSupported() = false');
      }
    } catch (e) {
      console.error('[Pigeon Main] Notification error:', e);
    }
  }

  if (process.platform === 'linux') {
    const notifyArgs = [
      '-p',
      '-a', 'Pigeon',
      '-i', icon,
      '-u', 'normal',
      '-t', '7000',
      '-A', openAction,
      '-A', readAction
    ];

    // Умная замена уведомления (-r <id>), только если предыдущее уведомление ещё живо на экране!
    const canReplace = prev && prev.notifId && activeNotifications.has(prev.notifId) && (now - prev.time < MAIN_REPLACE_WINDOW_MS);
    if (canReplace) {
      notifyArgs.push('-r', prev.notifId.toString());
    }

    notifyArgs.push(notifTitle, notifBody);

    const child = spawn('notify-send', notifyArgs);
    let currentNid = canReplace ? prev.notifId : null;
    let notificationDelivered = false;
    let fallbackShown = false;
    const showFallbackOnce = () => {
      if (fallbackShown) return;
      fallbackShown = true;
      showElectronNotificationFallback();
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.trim().split('\n');
      lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed === 'read') {
          console.log(`[Pigeon Main] 🖱️ Нажата кнопка "Прочитать" в системном уведомлении! Открытие диалога [${convKey}]`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
            if (convId) {
              mainWindow.webContents.send('open-conversation', convId);
            }
          }
          dismissNotificationByConvId(convId, currentNid, child);
        } else if (trimmed === 'default' || trimmed === 'open') {
          console.log(`[Pigeon Main] 🖱️ Клик по уведомлению: открытие диалога [${convKey}]`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
            if (convId) {
              mainWindow.webContents.send('open-conversation', convId);
            }
          }
          dismissNotificationByConvId(convId, currentNid, child);
        } else {
          const nid = parseInt(trimmed, 10);
          if (!isNaN(nid)) {
            currentNid = nid;
            notificationDelivered = true;
            activeNotifications.set(nid, { child, convId });
            lastNotifiedInMain.set(convKey, { body: notifBody, time: now, notifId: nid });
          }
        }
      });
    });

    child.on('close', (code) => {
      if (currentNid) {
        activeNotifications.delete(currentNid);
      }
      if (code !== 0 && !notificationDelivered) {
        console.warn('[Pigeon Main] notify-send завершился с ошибкой, откат на Electron Notification');
        showFallbackOnce();
      }
    });

    child.on('error', (err) => {
      console.warn('[Pigeon Main] notify-send недоступен или вернул ошибку, откат на Electron Notification:', err.message || err);
      showFallbackOnce();
    });

    lastNotifiedInMain.set(convKey, { body: notifBody, time: now, notifId: currentNid });
  } else {
    showElectronNotificationFallback();
  }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isVisible()) {
    if (mainWindow.isMinimized()) {
      console.log('[Pigeon Main] 🪟 Восстановление минимизированного окна из трея');
      mainWindow.restore();
      mainWindow.focus();
    } else {
      console.log('[Pigeon Main] 🚪 Клик по трею: окно свернуто в трей');
      mainWindow.hide();
    }
  } else {
    console.log('[Pigeon Main] 🪟 Клик по трею: окно развернуто');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const isRu = appConfig.language === 'ru';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRu ? 'Открыть Pigeon' : 'Open Pigeon',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: isRu ? 'Прочитать все сообщения' : 'Mark all as read',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-mark-all-read');
        }
      }
    },

    {
      label: isRu
        ? (appConfig.notificationsEnabled !== false ? 'Отключить уведомления' : 'Включить уведомления')
        : (appConfig.notificationsEnabled !== false ? 'Disable notifications' : 'Enable notifications'),
      click: () => {
        const nextState = !(appConfig.notificationsEnabled !== false);
        setNotificationsEnabled(nextState);
        if (nextState) {
          playNotificationSound(appConfig.soundFile, true);
        }
      }
    },
    { type: 'separator' },
    {
      label: isRu ? 'Закрыть Pigeon' : 'Exit Pigeon',
      click: () => {
        console.log('[Pigeon Main] 🚨 Tray: Exit Pigeon clicked');
        isQuitting = true;
        dismissAllNotifications();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

async function applyLanguageSession(lang) {
  const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 год
  try {
    await session.defaultSession.cookies.set({
      url: 'https://x.com',
      name: 'lang',
      value: lang,
      domain: '.x.com',
      path: '/',
      expirationDate: expiry
    });
    await session.defaultSession.cookies.set({
      url: 'https://chat.x.com',
      name: 'lang',
      value: lang,
      domain: '.x.com',
      path: '/',
      expirationDate: expiry
    });
  } catch (e) {
    console.error('[Pigeon Main] Error setting lang cookie:', e);
  }
}

async function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'ru') return;
  if (appConfig.language === lang) return;

  appConfig.language = lang;
  saveConfig(appConfig);
  console.log(`[Pigeon Main] 🌐 Смена языка интерфейса на: ${lang}`);

  await applyLanguageSession(lang);
  updateTrayMenu();
  setTrayState(currentUnread);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('language-changed', lang);
    mainWindow.webContents.reload();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(defaultTrayIconPath);
  tray = new Tray(icon);
  updateTrayMenu();
  setTrayState(0);

  tray.on('click', () => {
    toggleWindow();
  });

  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../assets/icon.ico')
    : appIconPath;
  const windowIcon = nativeImage.createFromPath(iconPath);

  let wasOpenedAtLogin = false;
  try {
    if (app.getLoginItemSettings) {
      const loginSettings = app.getLoginItemSettings();
      if (loginSettings && (loginSettings.wasOpenedAtLogin || loginSettings.wasOpenedAsHidden)) {
        wasOpenedAtLogin = true;
      }
    }
  } catch (e) {}

  const startHidden = process.argv.includes('--hidden') || process.argv.includes('--startup') || process.argv.includes('-h') || wasOpenedAtLogin;
  console.log(`[Pigeon Main] 🚀 Запуск окна (startHidden=${startHidden}, wasOpenedAtLogin=${wasOpenedAtLogin})`);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Pigeon',
    icon: windowIcon,
    show: !startHidden,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Убираем верхнюю полосу меню (File Edit View Window)
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.setIcon(windowIcon);

  if (process.platform === 'win32') {
    try {
      const psAumid = `
        $p = 'HKCU:\\Software\\Classes\\AppUserModelId\\com.pigeon.xchat'
        if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
        Set-ItemProperty -Path $p -Name 'DisplayName' -Value 'Pigeon' -Force -ErrorAction SilentlyContinue
      `;
      const buf = Buffer.from(psAumid, 'utf16le');
      const b64 = buf.toString('base64');
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
    } catch (e) {}
  }

  // Не пересылаем обычный console.log страницы в main process. XChat (React)
  // пишет их очень часто во время ввода и обновления ленты, а каждое такое
  // сообщение — отдельный IPC-переход между renderer и Node.
  // Оставляем только реальные ошибки: они нужны для диагностики, но не
  // конкурируют с отправкой/получением сообщений.
  mainWindow.webContents.on('console-message', (event, ...args) => {
    const msg = (event && typeof event.message === 'string') ? event.message : args[1] || '';
    const level = (event && typeof event.level === 'number') ? event.level : args[0];
    // Chromium: 0 = verbose, 1 = info, 2 = warning, 3 = error.
    if (msg && Number(level) >= 3) console.error(`[Browser Console]: ${msg}`);
  });

  // Очищаем User-Agent: выдаем чистый стандартный Google Chrome (без Electron и Pigeon),
  // чтобы серверы и скрипты X/Twitter не блокировали запросы и не вызывали сбой интерфейса
  const rawUA = session.defaultSession.getUserAgent();
  const cleanUserAgent = rawUA
    .replace(/Electron\/\S+\s?/g, '')
    .replace(/Pigeon\/\S+\s?/g, '')
    .trim();
  app.userAgentFallback = cleanUserAgent;
  session.defaultSession.setUserAgent(cleanUserAgent);
  mainWindow.webContents.setUserAgent(cleanUserAgent);
  console.log(`[Pigeon Main] 🌐 Чистый User-Agent установлен: ${cleanUserAgent}`);

  // Автоматически разрешаем необходимые разрешения (микрофон, камера, аудио, видео, уведомления) для звонков в XChat
  const ALLOWED_PERMISSIONS = new Set([
    'notifications',
    'media',
    'microphone',
    'camera',
    'audioCapture',
    'videoCapture',
    'clipboard-read',
    'clipboard-sanitized-write',
    'speaker-selection',
    'fullscreen',
    'display-capture'
  ]);

  function isAllowedXHost(hostname) {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    return h === 'x.com' ||
           h === 'chat.x.com' ||
           h === 'twitter.com' ||
           h.endsWith('.x.com') ||
           h.endsWith('.twitter.com') ||
           h === 'accounts.google.com' ||
           h.endsWith('.google.com') ||
           h === 'appleid.apple.com' ||
           h.endsWith('.apple.com');
  }

  function isChatUrl(parsed) {
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'chat.x.com';
  }

  function isXLoginUrl(parsed) {
    if (parsed.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(parsed.hostname.toLowerCase())) return false;
    // X проводит вход, выход, подтверждения и восстановление аккаунта через
    // последовательность внутренних /i/flow/* переходов. Блокировка хотя бы
    // одного шага оставляет окно авторизации пустым.
    return /^\/i\/flow\//.test(parsed.pathname) ||
      /^\/(login|logout|account\/access)/.test(parsed.pathname);
  }

  function isExternalAuthProvider(parsed) {
    const host = parsed.hostname.toLowerCase();
    return host === 'accounts.google.com' || host.endsWith('.google.com') ||
      host === 'appleid.apple.com' || host.endsWith('.apple.com');
  }

  let xLoginInProgress = false;

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const reqUrl = (details && details.requestingUrl) || webContents.getURL();
    let isOriginAllowed = false;
    try {
      const parsed = new URL(reqUrl);
      isOriginAllowed = parsed.protocol === 'https:' && isAllowedXHost(parsed.hostname);
    } catch (e) {}

    if (isOriginAllowed && ALLOWED_PERMISSIONS.has(permission)) {
      console.log(`[Pigeon Permission] ✅ Разрешен доступ к: ${permission} для ${reqUrl}`);
      return callback(true);
    }
    console.warn(`[Pigeon Permission] ⛔ Отклонен запрос разрешения: ${permission} (Origin: ${reqUrl})`);
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    let isOriginAllowed = false;
    try {
      const originToCheck = requestingOrigin || webContents.getURL();
      const parsed = new URL(originToCheck);
      isOriginAllowed = parsed.protocol === 'https:' && isAllowedXHost(parsed.hostname);
    } catch (e) {}

    return isOriginAllowed && ALLOWED_PERMISSIONS.has(permission);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (isChatUrl(parsed) || isXLoginUrl(parsed) || isExternalAuthProvider(parsed)) {
        return { action: 'allow' };
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch (e) {
      console.warn('[Pigeon Navigation] Ошибка в setWindowOpenHandler:', e);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (isChatUrl(parsed) || isExternalAuthProvider(parsed)) {
        return;
      }
      if (isXLoginUrl(parsed)) {
        xLoginInProgress = true;
        return;
      }
      event.preventDefault();
      if (xLoginInProgress && ['x.com', 'twitter.com'].includes(parsed.hostname.toLowerCase())) {
        xLoginInProgress = false;
        mainWindow.loadURL('https://chat.x.com').catch(() => {});
        return;
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        console.log(`[Pigeon Navigation] 🌐 Перенаправление внешней ссылки в браузер: ${targetUrl}`);
        shell.openExternal(targetUrl);
      }
    } catch (e) {
      event.preventDefault();
    }
  });

  // Серверные редиректы после logout/login не всегда приходят как
  // will-navigate, поэтому применяем ту же политику и к ним.
  mainWindow.webContents.on('will-redirect', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (isChatUrl(parsed) || isExternalAuthProvider(parsed)) return;
      if (isXLoginUrl(parsed)) {
        xLoginInProgress = true;
        return;
      }
      event.preventDefault();
      // После успешного входа X часто перенаправляет на x.com/home. Возвращаем
      // пользователя в оболочку чата, не открывая обычную ленту X снаружи.
      if (xLoginInProgress && ['x.com', 'twitter.com'].includes(parsed.hostname.toLowerCase())) {
        xLoginInProgress = false;
        mainWindow.loadURL('https://chat.x.com').catch(() => {});
        return;
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(targetUrl);
      }
    } catch (e) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-navigate', (_event, url) => {
    try {
      if (isChatUrl(new URL(url))) xLoginInProgress = false;
    } catch (e) {}
  });

  // Не подключаем webRequest-хуки к трафику XChat. Такие хуки вызываются на
  // каждом запросе (включая GraphQL-отправку и realtime) и заставляют Chromium
  // ожидать main process. Ghost Mode больше не меняет транспорт, а язык уже
  // сохраняется в cookie, поэтому перехват не даёт полезной функциональности.

  // Горячие клавиши перезагрузки (F5 / Ctrl+R / Ctrl+Shift+R), отладки (F12) и приватности
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'r') || (input.control && input.key === 'F5')) {
        console.log('[Pigeon Main] 🔄 Принудительная перезагрузка страницы с очисткой кэша (Ctrl+Shift+R / Ctrl+F5)');
        session.defaultSession.clearCache().catch(() => {});
        mainWindow.webContents.reloadIgnoringCache();
        event.preventDefault();
      } else if (((input.control || input.meta) && input.key.toLowerCase() === 'r') || input.key === 'F5') {
        mainWindow.reload();
        event.preventDefault();
      }
      if (((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
      // Boss Key: Ctrl+Alt+H
      if ((input.control || input.meta) && input.alt && (input.key.toLowerCase() === 'h' || input.code === 'KeyH')) {
        if (appConfig.bossKeyEnabled !== false) {
          event.preventDefault();
          triggerBossKey();
        }
      }
      // Privacy Blur: Ctrl+Shift+P
      if ((input.control || input.meta) && input.shift && (input.key.toLowerCase() === 'p' || input.code === 'KeyP')) {
        event.preventDefault();
        setPrivacyBlur(!appConfig.privacyBlur);
      }
    }
  });

  // Принудительно окрашиваем фон в черный при любой навигации еще до парсинга DOM
  mainWindow.webContents.on('did-start-navigation', () => {
    mainWindow.webContents.insertCSS(`
      html, body { background-color: #000000 !important; }
      #x-chat-conversation-list { scrollbar-width: none !important; }
      #x-chat-conversation-list::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
    `).catch(() => {});
  });

  // Создаём BrowserView оверлей поверх окна для абсолютной защиты от любых белых вспышек
  const splashView = new BrowserView();
  mainWindow.setBrowserView(splashView);

  function syncSplashBounds() {
    if (!mainWindow || mainWindow.isDestroyed() || !splashView) return;
    const [w, h] = mainWindow.getContentSize();
    splashView.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  syncSplashBounds();
  splashView.setAutoResize({ width: true, height: true });
  mainWindow.on('resize', syncSplashBounds);

  const splashPath = path.join(__dirname, 'splash.html');
  splashView.webContents.loadFile(splashPath);
  splashView.webContents.once('did-finish-load', () => {
    if (appConfig.reducedMotion) {
      splashView.webContents.executeJavaScript("document.documentElement.classList.add('reduced-motion')").catch(() => {});
    }
  });

  // Параллельно загружаем XChat в основном окне (под оверлеем)
  mainWindow.loadURL('https://chat.x.com').catch((err) => {
    console.error('[Pigeon Main] ❌ Ошибка loadURL:', err);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.warn(`[Pigeon Main] ⚠️ Ошибка загрузки ${validatedURL}: [${errorCode}] ${errorDescription}`);
  });

  // После очистки cookies chat.x.com иногда отвечает пустым документом вместо
  // ссылки на вход. В таком состоянии даём странице время на старт, затем
  // открываем официальный поток входа X в том же окне.
  mainWindow.webContents.on('did-finish-load', () => {
    const loadedUrl = mainWindow.webContents.getURL();
    try {
      if (!isChatUrl(new URL(loadedUrl))) return;
    } catch {
      return;
    }

    setTimeout(async () => {
      if (mainWindow.isDestroyed() || mainWindow.webContents.getURL() !== loadedUrl) return;
      try {
        const textLength = await mainWindow.webContents.executeJavaScript(
          'document.body ? document.body.innerText.trim().length : 0',
          true
        );
        if (textLength === 0 && mainWindow.webContents.getURL() === loadedUrl) {
          xLoginInProgress = true;
          await mainWindow.loadURL('https://x.com/i/flow/login');
        }
      } catch (error) {
        console.warn('[Pigeon Login] Не удалось проверить пустую страницу:', error);
      }
    }, 2500);
  });

  // Плавное растворение заставки: ждем загрузки страницы или минимум 1.6 сек
  let splashDismissed = false;
  const splashStartTime = Date.now();
  const minSplashTime = 1600;

  function dismissSplash() {
    if (splashDismissed || !mainWindow || mainWindow.isDestroyed()) return;
    splashDismissed = true;

    try {
      splashView.webContents.executeJavaScript("document.documentElement.classList.add('is-leaving')").catch(() => {});
    } catch (e) {}

    setTimeout(() => {
      try {
        console.log('[Pigeon Main] 🎬 Окончательное удаление оверлея splashView');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.removeListener('resize', syncSplashBounds);
          mainWindow.removeBrowserView(splashView);
          try {
            if (splashView.webContents && !splashView.webContents.isDestroyed()) {
              splashView.webContents.close();
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error('[Pigeon Main] Ошибка removeBrowserView:', e);
      }
    }, 380);
  }

  mainWindow.webContents.once('did-finish-load', () => {
    const elapsed = Date.now() - splashStartTime;
    const remaining = Math.max(0, minSplashTime - elapsed);
    setTimeout(dismissSplash, remaining);
    scheduleAutomaticUpdateCheck();
  });

  // Предохранитель: закрыть сплэш максимум через 4 секунды при медленном интернете
  setTimeout(dismissSplash, 4000);

  // Закрытие по крестику прячет окно в трей
  mainWindow.on('close', (event) => {
    console.log(`[Pigeon Main] 🚪 mainWindow close event (isQuitting=${isQuitting})`);
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('hide', () => {
    console.log('[Pigeon Main] 🚪 mainWindow свернуто в трей (hide)');
  });

  mainWindow.on('show', () => {
    console.log('[Pigeon Main] 🪟 mainWindow отображено (show)');
  });

  mainWindow.on('closed', () => {
    console.log('[Pigeon Main] 🚪 mainWindow closed event');
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    getOrCreateSoundWindow();
    if (process.platform === 'win32') {
      getOrCreateToastWindow();
    }

    // Регистрация ярлыка в меню Пуск с AppUserModelId для Центра уведомлений Windows 10/11
    if (process.platform === 'win32') {
      try {
        app.setAppUserModelId('com.pigeon.xchat');
        const programsDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const pigeonFolder = path.join(programsDir, 'Pigeon');
        if (!fs.existsSync(pigeonFolder)) {
          try { fs.mkdirSync(pigeonFolder, { recursive: true }); } catch (e) {}
        }
        const shortcutOptions = {
          target: process.execPath,
          cwd: path.dirname(process.execPath),
          appUserModelId: 'com.pigeon.xchat',
          description: 'Pigeon - Twitter/X Direct Messenger',
          icon: process.execPath,
          iconIndex: 0
        };
        if (typeof shell.writeShortcutLink === 'function') {
          const s1 = shell.writeShortcutLink(path.join(programsDir, 'Pigeon.lnk'), 'create', shortcutOptions);
          const s2 = shell.writeShortcutLink(path.join(pigeonFolder, 'Pigeon.lnk'), 'create', shortcutOptions);
          console.log(`[Pigeon Main] 📌 Start Menu shortcuts created with AUMID com.pigeon.xchat (root: ${s1}, folder: ${s2})`);
        }

        // Принудительное включение баннеров и уведомлений в реестре Windows 10
        const aKey = 'HKCU\\Software\\Classes\\AppUserModelId\\com.pigeon.xchat';
        execSync(`reg add "${aKey}" /v "DisplayName" /t REG_SZ /d "Pigeon" /f`, { windowsHide: true, stdio: 'ignore' });
        execSync(`reg add "${aKey}" /v "IconUri" /t REG_SZ /d "${process.execPath}" /f`, { windowsHide: true, stdio: 'ignore' });

        const nKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.pigeon.xchat';
        execSync(`reg add "${nKey}" /v "Enabled" /t REG_DWORD /d 1 /f`, { windowsHide: true, stdio: 'ignore' });
        execSync(`reg add "${nKey}" /v "ShowBanner" /t REG_DWORD /d 1 /f`, { windowsHide: true, stdio: 'ignore' });
        execSync(`reg add "${nKey}" /v "ShowInActionCenter" /t REG_DWORD /d 1 /f`, { windowsHide: true, stdio: 'ignore' });

        // Автозапуск Windows при включении ПК (в фоне в трее)
        if (appConfig.autoStart !== false) {
          app.setLoginItemSettings({
            openAtLogin: true,
            path: process.execPath,
            args: ['--hidden']
          });
          console.log('[Pigeon Main] 🚀 Автозапуск Windows синхронизирован: ВКЛ (args: --hidden)');
        } else {
          app.setLoginItemSettings({
            openAtLogin: false,
            path: process.execPath,
            args: []
          });
          console.log('[Pigeon Main] 🚀 Автозапуск Windows синхронизирован: ВЫКЛ');
        }
      } catch (e) {
        console.warn('[Pigeon Main] ⚠️ Failed to register Start Menu shortcuts / registry:', e.message || e);
      }
    }

    if (process.platform === 'linux') {
      try {
        syncLinuxAutoStart(appConfig.autoStart !== false);
      } catch (e) {
        console.warn('[Pigeon Main] ⚠️ Не удалось синхронизировать Linux-автозапуск:', e.message || e);
      }
    }

    // Глобальный хоткей Boss Key / Показать-Скрыть: Ctrl+Alt+H
    try {
      globalShortcut.register('CommandOrControl+Alt+H', () => {
        if (appConfig.bossKeyEnabled !== false) {
          triggerBossKey();
        }
      });
    } catch (err) {}

    // Хоткей прочитать все: Ctrl+Shift+A (фоновый режим, окно НЕ открывается)
    try {
      globalShortcut.register('CommandOrControl+Shift+A', () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-mark-all-read');
        }
      });
    } catch (err) {}

    // Обработка аппаратного клика по диалогу
    ipcMain.on('click-conversation', async (event, { x, y }) => {
      const numX = Math.round(Number(x));
      const numY = Math.round(Number(y));
      if (!Number.isFinite(numX) || !Number.isFinite(numY) || numX < 0 || numY < 0) {
        event.reply('click-conversation-ack');
        return;
      }

      if (mainWindow && mainWindow.isVisible()) {
        // Аппаратный клик мыши на уровне Chromium C++ шлём только если окно открыто пользователем
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: numX, y: numY });
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: numX, y: numY, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 40));
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: numX, y: numY, button: 'left', clickCount: 1 });

        // 2. Дополнительный триггер в DOM контексте страницы
        try {
          await mainWindow.webContents.executeJavaScript(`
            (() => {
              try {
                const el = document.elementFromPoint(${numX}, ${numY});
                if (el) {
                  el.click();
                  let cur = el;
                  for (let d = 0; d < 5 && cur && cur !== document.body; d++) {
                    for (const k in cur) {
                      if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) {
                        const props = cur[k];
                        if (props && typeof props.onClick === 'function') {
                          props.onClick({ stopPropagation: () => {}, preventDefault: () => {}, isTrusted: true, target: el, currentTarget: cur });
                        }
                      }
                    }
                    cur = cur.parentElement;
                  }
                }
              } catch (e) {}
            })()
          `);
        } catch (e) {}
      }

      event.reply('click-conversation-ack');
    });

    ipcMain.on('mark-all-read-done', () => {
      dismissAllNotifications();
      setTrayState(0);
    });

    ipcMain.on('mark-conversation-read-done', (_event, convId) => {
      if (convId) {
        dismissNotificationByConvId(convId);
      }
    });

    // Chromium не даёт стандартное меню правой кнопки в Electron. Для
    // полноэкранного просмотра фото оставляем маленькое нативное меню, чтобы
    // картинку можно было скопировать прямо в буфер обмена.
    ipcMain.on('show-image-context-menu', (event, position = {}) => {
      const sender = event.sender;
      if (!sender || sender.isDestroyed() || typeof sender.copyImageAt !== 'function') return;
      const x = Math.round(Number(position.x));
      const y = Math.round(Number(position.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return;

      const ownerWindow = BrowserWindow.fromWebContents(sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) return;
      const isRu = appConfig.language === 'ru';
      const menu = Menu.buildFromTemplate([{
        label: isRu ? 'Копировать изображение' : 'Copy image',
        click: () => {
          try {
            sender.copyImageAt(x, y);
          } catch (e) {
            console.warn('[Pigeon Clipboard] Не удалось скопировать изображение:', e.message || e);
          }
        }
      }]);
      menu.popup({ window: ownerWindow, x, y });
    });

    // Обновление бейджа трея
    ipcMain.on('unread-count', (_event, count) => {
      setTrayState(count);
    });

    if (mainWindow) {
      mainWindow.on('focus', () => {
        dismissAllNotifications();
      });
    }

    ipcMain.on('toast-hover-start', () => {
      if (!toastTimeout || toastPaused) return;
      toastPaused = true;
      toastRemaining = Math.max(0, toastDeadline - Date.now());
      clearTimeout(toastTimeout);
      toastTimeout = null;
      if (toastWindow && !toastWindow.isDestroyed()) {
        toastWindow.webContents.send('set-toast-progress', { paused: true, duration: toastRemaining });
      }
    });

    ipcMain.on('toast-hover-end', () => {
      if (!toastPaused) return;
      toastPaused = false;
      scheduleDesktopToastHide(toastRemaining || 1);
    });

    ipcMain.on('toast-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        if (currentToastConvId) {
          mainWindow.webContents.send('open-conversation', currentToastConvId);
        }
      }
      toastPaused = false;
      hideDesktopToast();
    });

    ipcMain.on('toast-close', () => {
      toastPaused = false;
      hideDesktopToast();
    });

    // Обработка нового входящего сообщения
    ipcMain.on('incoming-message', async (_event, data) => {
      if (appConfig.notificationsEnabled === false) {
        console.log(`[Pigeon Main] 🔕 Всплывающие уведомления отключены в настройках`);
        return;
      }

      const { conversationId, title, body, avatarUrl, mediaType } = (typeof data === 'object' && data) ? data : {};
      const iconPath = await fetchAvatar(avatarUrl);
      sendDesktopNotification(conversationId, title, body, iconPath, mediaType);
    });

    ipcMain.on('renderer-performance-trace-start', async (event) => {
      if (!ENABLE_RENDERER_PROFILING) return;
      const sender = event.sender;
      if (!mainWindow || sender !== mainWindow.webContents || activeRendererCpuProfile) return;
      try {
        if (sender.debugger.isAttached()) return;
        sender.debugger.attach('1.3');
        await sender.debugger.sendCommand('Profiler.enable');
        await sender.debugger.sendCommand('Profiler.start');
        activeRendererCpuProfile = { webContents: sender, startedAt: Date.now() };
        // Даже если сообщение так и не отправили, не оставляем profiler включённым.
        rendererCpuProfileTimeout = setTimeout(stopRendererCpuProfile, 10000);
      } catch (error) {
        try {
          if (sender.debugger.isAttached()) sender.debugger.detach();
        } catch (e) {}
        console.warn('[Pigeon Performance] Не удалось запустить CPU-профиль:', error.message || error);
      }
    });

    ipcMain.on('renderer-performance-sample', (_event, sample) => {
      if (!ENABLE_RENDERER_PROFILING) return;
      const safe = {
        kind: sample && sample.kind === 'send' ? 'send' : 'unknown',
        at: Number(sample?.at) || Date.now(),
        domNodes: Math.max(0, Math.min(Number(sample?.domNodes) || 0, 1000000)),
        longTaskCount: Math.max(0, Math.min(Number(sample?.longTaskCount) || 0, 10000)),
        longestTaskMs: Math.max(0, Math.min(Number(sample?.longestTaskMs) || 0, 60000)),
        heapBytes: Number.isFinite(Number(sample?.heapBytes)) ? Number(sample.heapBytes) : null
      };
      try {
        fs.appendFile(performanceLogPath, `${JSON.stringify(safe)}\n`, () => {});
      } catch (e) {}
      if (safe.kind === 'send') stopRendererCpuProfile();
    });

    // Обработка настроек (звуки, язык, приватность)
    ipcMain.handle('get-settings', () => {
      return getRendererSettings(true);
    });

    ipcMain.handle('get-app-update-state', () => ({ ...appUpdateState, language: appConfig.language }));

    ipcMain.handle('start-app-update', async () => {
      initializeAutoUpdater();
      if (!updaterInitialized) return { ok: false, error: 'updates-unavailable' };
      updateInstallRequested = true;
      try {
        sendAppUpdateState({ status: 'downloading', percent: 0, error: '' });
        await autoUpdater.downloadUpdate();
        return { ok: true };
      } catch (error) {
        const safeError = getSafeUpdateError(error);
        sendAppUpdateState({ status: 'error', error: safeError });
        return { ok: false, error: safeError };
      }
    });

    ipcMain.on('dismiss-app-update', () => {
      if (appUpdateState.status === 'available') {
        dismissedUpdateVersion = String(appUpdateState.version || '');
      }
      appUpdateState = { status: 'idle', currentVersion: app.getVersion() };
    });

    ipcMain.handle('retry-app-update-check', async () => {
      initializeAutoUpdater();
      updateInstallRequested = false;
      if (!updaterInitialized) return { ok: false, error: 'updates-unavailable' };
      try {
        await autoUpdater.checkForUpdates();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: getSafeUpdateError(error) };
      }
    });

    ipcMain.handle('get-chat-wallpaper-assets', async () => {
      const entries = await Promise.all(Object.entries(BUNDLED_CHAT_WALLPAPERS).map(async ([id, fileName]) => {
        try {
          const buffer = await fs.promises.readFile(path.join(bundledWallpapersDir, 'thumbs', fileName));
          return [id, `data:image/webp;base64,${buffer.toString('base64')}`];
        } catch (e) {
          return [id, ''];
        }
      }));
      return Object.fromEntries(entries);
    });

    ipcMain.handle('get-chat-wallpaper-asset', (_event, id) => {
      return typeof id === 'string' && BUNDLED_CHAT_WALLPAPERS[id]
        ? getBundledWallpaperDataUrl(id)
        : '';
    });

    ipcMain.handle('choose-chat-wallpaper', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: appConfig.language === 'ru' ? 'Выберите обои для чата' : 'Choose a chat wallpaper',
        properties: ['openFile'],
        filters: [
          { name: appConfig.language === 'ru' ? 'Изображения' : 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
        ]
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };

      try {
        const sourcePath = path.resolve(result.filePaths[0]);
        const extension = path.extname(sourcePath).toLowerCase();
        const stat = await fs.promises.stat(sourcePath);
        if (!CHAT_WALLPAPER_EXTENSIONS.has(extension)) return { ok: false, error: 'unsupported-format' };
        if (!stat.isFile() || stat.size > MAX_CHAT_WALLPAPER_BYTES) return { ok: false, error: 'file-too-large' };

        await fs.promises.mkdir(wallpaperDir, { recursive: true });
        const destinationPath = path.join(wallpaperDir, `custom${extension}`);
        if (sourcePath !== destinationPath) {
          await fs.promises.copyFile(sourcePath, destinationPath);
        }
        for (const oldExtension of CHAT_WALLPAPER_EXTENSIONS) {
          const oldPath = path.join(wallpaperDir, `custom${oldExtension}`);
          if (oldPath !== destinationPath) await fs.promises.rm(oldPath, { force: true });
        }
        appConfig.chatWallpaperCustomPath = destinationPath;
        appConfig.chatWallpaper = 'custom';
        saveConfig(appConfig);
        return {
          ok: true,
          chatWallpaper: 'custom',
          chatWallpaperDataUrl: getCustomWallpaperDataUrl()
        };
      } catch (error) {
        console.error('[Pigeon Wallpaper] Не удалось сохранить изображение:', error);
        return { ok: false, error: 'copy-failed' };
      }
    });

    // Полный выход из X в пределах профиля Pigeon. Очищаем только хранилища
    // Electron-приложения: cookies, сессии и кэшированные медиа X. Обычную
    // системную папку «Загрузки» намеренно не трогаем — там могут быть файлы,
    // которые пользователь сохранил вручную.
    ipcMain.handle('sign-out-and-clear-data', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'window-unavailable' };
      }

      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: [appConfig.language === 'ru' ? 'Отмена' : 'Cancel', appConfig.language === 'ru' ? 'Выйти и удалить' : 'Sign out and delete'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: appConfig.language === 'ru' ? 'Выйти из сессии?' : 'Sign out of this session?',
        message: appConfig.language === 'ru'
          ? 'Будут удалены сессия X, cookies, локальные данные и кэшированные медиа Pigeon.'
          : 'Your X session, cookies, local data, and Pigeon cached media will be removed.',
        detail: appConfig.language === 'ru'
          ? 'Настройки Pigeon и файлы, сохранённые вручную в папку «Загрузки», останутся.'
          : 'Pigeon settings and files you manually saved to Downloads will remain.'
      });
      if (result.response !== 1) return { ok: false, cancelled: true };

      try {
        const pigeonSession = mainWindow.webContents.session;
        await pigeonSession.clearCache();
        await pigeonSession.clearStorageData({
          storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'websql', 'cachestorage', 'shadercache']
        });
        if (typeof pigeonSession.clearAuthCache === 'function') {
          await pigeonSession.clearAuthCache();
        }
        if (typeof pigeonSession.flushStorageData === 'function') {
          await pigeonSession.flushStorageData();
        }

        // Временный кэш аватаров Pigeon находится отдельно от Chromium-кэша.
        await fs.promises.rm(avatarsCacheDir, { recursive: true, force: true });
        await fs.promises.mkdir(avatarsCacheDir, { recursive: true });
        ensureExtractedIcon();

        // После выхода возвращаем пользователя в оболочку чата. Если X
        // потребует авторизацию, его внутренний flow будет разрешён отдельно
        // навигационным фильтром, но не открывается принудительно заранее.
        xLoginInProgress = false;
        await mainWindow.loadURL('https://chat.x.com');
        return { ok: true };
      } catch (error) {
        console.error('[Pigeon Session] Не удалось очистить данные:', error);
        return { ok: false, error: 'clear-failed' };
      }
    });

    ipcMain.on('set-autostart', (_event, enabled) => {
      setAutoStart(enabled);
    });

    ipcMain.on('set-notifications-enabled', (_event, enabled) => {
      setNotificationsEnabled(enabled);
    });

    ipcMain.on('set-sound-enabled', (_event, enabled) => {
      setSoundEnabled(enabled);
    });

    ipcMain.on('set-sound-file', (_event, file) => {
      setSoundFile(file);
    });

    ipcMain.on('play-sound-preview', (_event, file) => {
      if (isSafeSoundFile(file)) {
        playNotificationSound(file, true);
      }
    });

    ipcMain.on('set-language', (_event, lang) => {
      setLanguage(lang);
    });

    ipcMain.on('set-ghost-mode', (_event, enabled) => {
      setGhostMode(enabled);
    });

    ipcMain.on('set-privacy-blur', (_event, enabled) => {
      setPrivacyBlur(enabled);
    });

    ipcMain.on('set-boss-key-enabled', (_event, enabled) => {
      setBossKeyEnabled(enabled);
    });

    ipcMain.on('set-reduced-motion', (_event, enabled) => {
      setReducedMotion(enabled);
    });

    ipcMain.on('set-chat-wallpaper', (_event, settings) => {
      setChatWallpaper(settings);
    });

    ipcMain.on('boss-key-trigger', () => {
      if (appConfig.bossKeyEnabled !== false) {
        triggerBossKey();
      }
    });

    ipcMain.handle('get-language', () => {
      return appConfig.language || 'en';
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', (e) => {
  console.log(`[Pigeon Main] ⚠️ app before-quit (isQuitting=${isQuitting})`);
  if (soundWindow && !soundWindow.isDestroyed()) {
    try {
      soundWindow.destroy();
    } catch (e) {}
    soundWindow = null;
  }
});

app.on('will-quit', () => {
  console.log(`[Pigeon Main] ⚠️ app will-quit (isQuitting=${isQuitting})`);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  console.log(`[Pigeon Main] ⚠️ app window-all-closed (isQuitting=${isQuitting})`);
  if (isQuitting) {
    app.quit();
  }
});
