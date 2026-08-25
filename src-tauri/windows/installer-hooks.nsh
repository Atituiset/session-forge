; SessionForge NSIS installer hooks — release file locks held by the engine
; sidecar / main process before overwrite (tray apps keep them alive).
; Keep ASCII-only and quote-free args: makensis parses strictly.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping SessionForge background processes..."
  nsExec::Exec `taskkill /F /T /IM session-forge-engine.exe`
  nsExec::Exec `taskkill /F /T /IM SessionForge.exe`
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping SessionForge background processes..."
  nsExec::Exec `taskkill /F /T /IM session-forge-engine.exe`
  nsExec::Exec `taskkill /F /T /IM SessionForge.exe`
  Sleep 600
!macroend
