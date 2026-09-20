const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'linux') process.exit(0);

const projectDir = path.resolve(__dirname, '..');
const distDir = path.join(projectDir, 'dist');
const appImages = fs.readdirSync(distDir)
  .filter(name => /^Pigeon(?:-[\w.-]+)?\.AppImage$/.test(name))
  .map(name => ({ path: path.join(distDir, name), mtime: fs.statSync(path.join(distDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!appImages[0]) throw new Error('Linux AppImage was not found in dist');

const userHome = os.homedir();
const installDir = path.join(userHome, '.local', 'opt', 'pigeon');
const applicationsDir = path.join(userHome, '.local', 'share', 'applications');
const autostartDir = path.join(userHome, '.config', 'autostart');
const installedApp = path.join(installDir, 'Pigeon.AppImage');
const installedIcon = path.join(installDir, 'pigeon.png');
const temporaryApp = `${installedApp}.new`;

fs.mkdirSync(installDir, { recursive: true });
fs.mkdirSync(applicationsDir, { recursive: true });
fs.copyFileSync(appImages[0].path, temporaryApp);
fs.chmodSync(temporaryApp, 0o755);
fs.renameSync(temporaryApp, installedApp);
fs.copyFileSync(path.join(projectDir, 'assets', 'icon.png'), installedIcon);

const desktopEntry = `[Desktop Entry]
Name=Pigeon
Comment=Unofficial XChat Desktop Client
Exec=${installedApp}
TryExec=${installedApp}
Icon=${installedIcon}
Terminal=false
Type=Application
Categories=Network;Chat;InstantMessaging;
StartupWMClass=pigeon
StartupNotify=true
`;
fs.writeFileSync(path.join(applicationsDir, 'pigeon.desktop'), desktopEntry, { mode: 0o644 });

const autostartEntry = path.join(autostartDir, 'pigeon.desktop');
if (fs.existsSync(autostartEntry)) {
  const autostartDesktop = `[Desktop Entry]
Type=Application
Version=1.0
Name=Pigeon
Exec=${installedApp} --hidden
TryExec=${installedApp}
Icon=${installedIcon}
Terminal=false
StartupNotify=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(autostartEntry, autostartDesktop, { mode: 0o644 });
}

console.log(`[Pigeon] Local installation updated: ${installedApp}`);
