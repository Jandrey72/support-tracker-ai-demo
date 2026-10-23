# ==========================================================
#  Deja el bot arrancando solo al encender el servidor.
#  Se corre UNA sola vez, en PowerShell como administrador.
#
#  Uso:  cd C:\bot ; .\scripts-windows\instalar-servicio.ps1
#
#  Usa el Programador de tareas de Windows en vez de un servicio real:
#  no hay que instalar nada de terceros y se puede ver y parar desde la
#  interfaz grafica, que en un servidor compartido ayuda a que el de
#  al lado entienda que es esto.
# ==========================================================

$ErrorActionPreference = "Stop"
$TAREA = "SupportTrackerBot"
$NODE  = (Get-Command node).Source

if (-not (Test-Path C:\bot\dist\index.js)) {
    Write-Host "Falta compilar. Corriendo npm run build..." -ForegroundColor Yellow
    Set-Location C:\bot
    npm run build
}

$accion = New-ScheduledTaskAction -Execute $NODE `
          -Argument "dist\index.js" -WorkingDirectory "C:\bot"

# Al iniciar el sistema, sin necesidad de que alguien abra sesion.
$disparador = New-ScheduledTaskTrigger -AtStartup

# Si el bot se cae, que lo vuelva a levantar. Sin limite de tiempo:
# un bot de monitoreo no debe "terminar" nunca.
$ajustes = New-ScheduledTaskSettingsSet `
           -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
           -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
           -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
           -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask -TaskName $TAREA -Action $accion -Trigger $disparador `
    -Settings $ajustes -Principal $principal -Force `
    -Description "Support Tracker AI - bot de soportes por WhatsApp (Mi Empresa)" | Out-Null

Write-Host "`nTarea '$TAREA' registrada." -ForegroundColor Green
Write-Host "Arrancarla ahora:   Start-ScheduledTask -TaskName $TAREA"
Write-Host "Ver si corre:       Get-ScheduledTask -TaskName $TAREA | Get-ScheduledTaskInfo"
Write-Host "Pararla:            Stop-ScheduledTask  -TaskName $TAREA`n"
