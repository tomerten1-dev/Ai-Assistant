<#
  מתקין את המעקב אחרי המלאי כמשימה שרצה מהרגע שאת/ה מתחבר/ת למחשב.

  אין כאן שום דבר שדורש הרשאות מנהל: המשימה נוצרת תחת המשתמש שלך, קוראת
  קובץ שכבר יש לך גישה אליו, ומריצה Node שכבר מותקן. לא נוגעים בשום מערכת
  ולא צריך אישור מאף אחד.

      powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\install-watch.ps1

  להסרה:
      Unregister-ScheduledTask -TaskName "Pingwin inventory watch" -Confirm:$false
#>
param(
  [string]$Workbook = $env:PINGWIN_WORKBOOK,
  [string]$ServerUrl = $env:PINGWIN_BOT_URL,
  [string]$Token = $env:PINGWIN_BOT_TOKEN
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $Workbook) { throw "צריך נתיב לקובץ: -Workbook 'F:\...\commitments-winter-2027.xlsm'" }
if (-not (Test-Path $Workbook)) { throw "הקובץ לא נמצא: $Workbook" }
if (-not $ServerUrl) { $ServerUrl = 'http://localhost:8787' }

# משתני הסביבה נשמרים ברמת המשתמש, כדי שהמשימה תראה אותם
[Environment]::SetEnvironmentVariable('PINGWIN_WORKBOOK', $Workbook, 'User')
[Environment]::SetEnvironmentVariable('PINGWIN_BOT_URL', $ServerUrl, 'User')
if ($Token) { [Environment]::SetEnvironmentVariable('PINGWIN_BOT_TOKEN', $Token, 'User') }

$node = (Get-Command node -ErrorAction Stop).Source
$action  = New-ScheduledTaskAction -Execute $node `
             -Argument "`"$root\tools\watch-inventory.js`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# חלון חבוי, ומופעל מחדש לבד אם הוא נופל
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'Pingwin inventory watch' -Action $action -Trigger $trigger `
  -Settings $set -Description 'מעדכן את מלאי הבוט מקובץ ההתחייבויות' -Force | Out-Null

Start-ScheduledTask -TaskName 'Pingwin inventory watch'
Write-Host "הותקן ורץ. הבוט יתעדכן לבד מעכשיו, בכל פעם שהקובץ נשמר."
Write-Host "לראות שהוא חי:  Get-ScheduledTask -TaskName 'Pingwin inventory watch'"
