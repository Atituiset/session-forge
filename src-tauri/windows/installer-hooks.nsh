; SessionForge NSIS installer hooks — release file locks held by the engine
; sidecar / main process before overwrite (tray apps keep them alive).

!macro SF_KILL_PROCS
  nsExec::Exec 'taskkill /F /T /IM "session-forge-engine.exe"'
  nsExec::Exec 'taskkill /F /T /IM "SessionForge.exe"'
  Sleep 600
!macroend

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "正在停止 SessionForge 后台进程…"
  ${SF_KILL_PROCS}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在停止 SessionForge 后台进程…"
  ${SF_KILL_PROCS}
!macroend
