const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('if ((0, macosVersion_1.isMacOsCatalina)()) {')) {
    content = content.replace(
      'if ((0, macosVersion_1.isMacOsCatalina)()) {\n            try {\n                await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);\n            }',
      'try {\n            await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);\n        }'
    );
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[patch-builder] Patched NsisTarget.js to use UninstallerReader for headless Linux builds.');
  }
}
