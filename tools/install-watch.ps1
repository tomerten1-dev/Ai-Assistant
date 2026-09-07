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

# בלי נתיב — פותחים חלון בחירה. שם הקובץ בעברית, ונתיב עברי שמוקלד ידנית
# ב-cmd נשבר בגלל דף הקוד; ככה לא מקלידים אותו בכלל.
if (-not $Workbook) {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = 'לבחור את קובץ ההתחייבויות (או קובץ כלשהו בתיקייה הנכונה)'
  $dlg.Filter = 'קבצי אקסל|*.xlsm;*.xlsx|הכול|*.*'
  if (Test-Path 'F:\') { $dlg.InitialDirectory = 'F:\' }
  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    throw 'לא נבחר קובץ.'
  }
  $Workbook = $dlg.FileName
}
if (-not (Test-Path $Workbook)) { throw "לא נמצא: $Workbook" }

# עוקבים אחרי התיקייה ולא אחרי הקובץ: השם משתנה בין עונות, ומעקב אחרי שם
# קבוע נשבר בשקט ביום שמישהו משנה אותו
if (-not (Get-Item $Workbook).PSIsContainer) {
  $Workbook = Split-Path -Parent $Workbook
}
Write-Host "עוקב אחרי התיקייה: $Workbook"
Write-Host "(הקובץ החדש ביותר בה נבחר אוטומטית — כולל אחרי שינוי שם)" 
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
