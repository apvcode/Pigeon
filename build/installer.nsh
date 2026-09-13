!macro customUnInstall
  ; Clean up the legacy v0.1.0 Run value. New installs use Electron's
  ; app.setLoginItemSettings so the in-app toggle remains authoritative.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pigeon"
!macroend
