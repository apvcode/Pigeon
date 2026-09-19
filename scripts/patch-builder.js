const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  const originalStart = '        if ((0, macosVersion_1.isMacOsCatalina)()) {';
  const originalEnd = '        await packager.signIf(uninstallerPath);';
  const patchMarker = '        // Pigeon: extract the generated uninstaller without Wine.';

  if (content.includes(originalStart)) {
    const start = content.indexOf(originalStart);
    const end = content.indexOf(originalEnd, start);

    if (end === -1) {
      throw new Error('[patch-builder] Could not locate the end of the NSIS uninstaller block.');
    }

    const replacement = `${patchMarker}\n        await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);\n`;
    content = content.slice(0, start) + replacement + content.slice(end);
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[patch-builder] Patched NsisTarget.js to use UninstallerReader for headless Linux builds.');
  } else if (!content.includes(patchMarker)) {
    throw new Error('[patch-builder] Unsupported app-builder-lib layout; update the NSIS patch.');
  }
}
