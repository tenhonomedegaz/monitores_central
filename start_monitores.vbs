Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = "C:\Users\Home\Desktop\monitores_central"
desktopExe = base & "\dist\win-unpacked\Monitores Central.exe"

If fso.FileExists(desktopExe) Then
  shell.Run """" & desktopExe & """ --background", 0, False
Else
  shell.Run "cmd /c cd /d """ & base & "\app_pedidos"" && python server.py", 0, False
  shell.Run "cmd /c cd /d """ & base & "\app_chamados"" && python server.py", 0, False
End If
