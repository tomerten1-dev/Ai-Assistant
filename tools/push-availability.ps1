<#
  דוחף את המלאי העדכני מקובץ ההתחייבויות אל השרת של הבוט.

  למה זה רץ כאן ולא בשרת: קובץ ההתחייבויות יושב על כונן F: — שיתוף פנימי
  שהשרת לא יכול להגיע אליו. אז המשרד דוחף, במקום שהשרת ימשוך.

  ולמה זה מפענח כאן: בקובץ ההתחייבויות יש שמות של לקוחות שהזמינו. הסקריפט
  מריץ את המפענח על המחשב הזה ושולח לשרת רק את data/availability.json —
  יחידות פנויות בלבד, מספרים, בלי שום מידע אישי. הקובץ המקורי לא עוזב את
  הרשת של החברה.

  התקנה חד-פעמית על המחשב שמארח את F: (רצוי השרת/NAS — מחשב שתמיד דלוק):
    1. להתקין Node.js LTS מ-https://nodejs.org
    2. git clone של הפרויקט לתיקייה מקומית, למשל C:\pingwin-bot
    3. להגדיר שני משתני סביבה ברמת המערכת:
         PINGWIN_BOT_URL    = https://bot.pingwin.co.il
         PINGWIN_BOT_TOKEN  = <אותו ערך כמו INVENTORY_TOKEN בשרת>
    4. Task Scheduler → Create Task (לא Basic):
         General  → "Run whether user is logged on or not"  ← חשוב
         Triggers → Daily, repeat every 3 hours, for a duration of 1 day
         Actions  → Program:  powershell.exe
                    Arguments: -NoProfile -ExecutionPolicy Bypass -File "C:\pingwin-bot\tools\push-availability.ps1"
                    Start in:  C:\pingwin-bot

  בדיקה ידנית:  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\push-availability.ps1 -VerboseLog
#>
param(
  [string]$Workbook = $env:PINGWIN_WORKBOOK,
  [string]$ServerUrl = $env:PINGWIN_BOT_URL,
  [string]$Token = $env:PINGWIN_BOT_TOKEN,
  [switch]$VerboseLog
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'push-availability.log'

function Say($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line
  if ($VerboseLog) { Write-Host $line }
}

# הישן ביותר שנשמור ביומן — אחרת הוא גדל בלי סוף
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) {
  Move-Item $log "$log.1" -Force
}

try {
  if (-not $Workbook)  { $Workbook = 'F:\<תיקייה>\commitments-winter-2027.xlsm' }
  if (-not $ServerUrl) { throw 'PINGWIN_BOT_URL is not set' }
  if (-not $Token)     { throw 'PINGWIN_BOT_TOKEN is not set' }
  if (-not (Test-Path $Workbook)) { throw "workbook not found: $Workbook" }

  # עותק זמני: הקובץ פתוח באקסל אצל מישהו כמעט תמיד, והמפענח לא אמור
  # להתמודד עם קובץ שמשתנה תוך כדי קריאה
  $tmp = Join-Path $env:TEMP ("commitments-{0}.xlsm" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item -LiteralPath $Workbook -Destination $tmp -Force
  Say "copied workbook ($([math]::Round((Get-Item $tmp).Length/1MB,1)) MB)"

  # מפענחים כאן. אם השער של ה-PII נופל — הבנייה נכשלת ושום דבר לא נשלח.
  Push-Location $root
  try {
    $build = & node 'tools/build-availability.js' $tmp 2>&1
    if ($LASTEXITCODE -ne 0) { throw "build failed: $build" }
    Say ($build -join ' | ')
  } finally { Pop-Location }

  Remove-Item $tmp -Force -ErrorAction SilentlyContinue

  $json = Get-Content (Join-Path $root 'data\availability.json') -Raw -Encoding UTF8
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)

  $res = Invoke-RestMethod -Method Post -Uri ("{0}/api/inventory" -f $ServerUrl.TrimEnd('/')) `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 120

  Say ("server accepted: {0} unit groups, {1} rooms (was {2})" -f $res.units, $res.rooms, $res.was)
  exit 0
}
catch {
  # השרת מתריע לבד כשהמלאי מתיישן, אבל קוד יציאה שונה מאפס נותן ל-Task
  # Scheduler להראות את הכישלון ברשימה, ולשלוח מייל אם הוגדר
  Say ("FAILED: " + $_.Exception.Message)
  Write-Error $_.Exception.Message
  exit 1
}
