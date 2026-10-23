# ==========================================================
#  Actualiza el bot con los cambios que subiste desde la Mac.
#
#  Uso:  cd C:\bot ; .\scripts-windows\actualizar.ps1
#
#  Hace todo el ciclo: baja el codigo, instala lo nuevo, ajusta la base,
#  compila y reinicia el servicio. Si algo falla, se detiene ahi mismo
#  en vez de seguir y dejar el bot a medias.
# ==========================================================

$ErrorActionPreference = "Stop"
$TAREA = "SupportTrackerBot"

# El bot se para PRIMERO: Windows no deja reemplazar archivos en uso, y
# `prisma generate` falla con EPERM si el motor esta abierto por el proceso.
Write-Host "`n=== 1/6  Parando el bot ===" -ForegroundColor Cyan
if (Get-ScheduledTask -TaskName $TAREA -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TAREA -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Write-Host "Bot detenido." -ForegroundColor Green
} else {
    Write-Host "La tarea no existe todavia; sigo." -ForegroundColor Yellow
}

Write-Host "`n=== 2/6  Bajando cambios de GitHub ===" -ForegroundColor Cyan
Set-Location C:\bot
git pull

Write-Host "`n=== 3/6  Instalando dependencias ===" -ForegroundColor Cyan
npm install

Write-Host "`n=== 4/6  Actualizando la base de datos ===" -ForegroundColor Cyan
# generate: regenera el cliente de Prisma (npm bloquea su postinstall).
# db push : aplica cambios del schema SIN borrar datos.
npx prisma generate
npx prisma db push

Write-Host "`n=== 5/6  Compilando ===" -ForegroundColor Cyan
npm run build

Write-Host "`n=== 6/6  Arrancando el bot ===" -ForegroundColor Cyan
if (Get-ScheduledTask -TaskName $TAREA -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TAREA
    Write-Host "Bot arrancado." -ForegroundColor Green
} else {
    Write-Host "La tarea '$TAREA' no existe todavia. Corre instalar-servicio.ps1 una vez." -ForegroundColor Yellow
}

Write-Host "`nListo. Revisa el log en C:\bot\logs\ o abre http://localhost:3000`n" -ForegroundColor Green
