!macro customInit
  DetailPrint "Encerrando a versao anterior do Monitores Central..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Monitores Central.exe"'
  Pop $0
  Sleep 1200

  DetailPrint "Preservando dados locais da versao anterior..."
  CreateDirectory "$APPDATA\monitores-central\data\app_pedidos"
  CreateDirectory "$APPDATA\monitores-central\data\app_chamados"
  CopyFiles /SILENT "$INSTDIR\resources\app\app_pedidos\*.json*" "$APPDATA\monitores-central\data\app_pedidos"
  CopyFiles /SILENT "$INSTDIR\resources\app\app_chamados\*.json*" "$APPDATA\monitores-central\data\app_chamados"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\Monitores Central\resources\app\app_pedidos\*.json*" "$APPDATA\monitores-central\data\app_pedidos"
  CopyFiles /SILENT "$LOCALAPPDATA\Programs\Monitores Central\resources\app\app_chamados\*.json*" "$APPDATA\monitores-central\data\app_chamados"
!macroend

!macro customInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Monitores Central"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "br.local.monitorescentral" '"$INSTDIR\Monitores Central.exe" --background'
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Monitores Central.exe"'
  Pop $0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Monitores Central"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "br.local.monitorescentral"
!macroend
