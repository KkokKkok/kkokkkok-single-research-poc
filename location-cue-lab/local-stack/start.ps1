# 꼭꼭 로컬 테스트 서버 시작: sidecar(8091) -> 분석 서버(3001) -> 백엔드(8098)
# 비밀값은 secrets.json / .env.local 에서 읽어 자식 프로세스 환경변수로만 전달하며 화면·로그에 출력하지 않습니다.
#
# 2026-11-17: 분석 서버는 기본으로 Research PoC 의 analysis-server.mjs (Claude 호출, OCR·탐지기 내장)를 띄웁니다.
#   이 경우 sidecar(8091)는 띄우지 않습니다. Claude 키는 Research PoC 의 location-cue-lab\.env (ANTHROPIC_API_KEY) 에서 읽습니다.
#   예전 구성(sidecar + KkokKkok-PoC 분석 서버)으로 띄우려면:  .\start.ps1 -Legacy
param([switch]$NoSidecar, [switch]$Legacy)

$ErrorActionPreference = 'Stop'
$Local   = $PSScriptRoot
$Research = 'C:\KKokKKok\KkokKkok-Research-PoC\location-cue-lab'
$ResearchDeps = 'C:\KKokKKok\KkokKkok-PoC'   # Research PoC 가 빌려 쓰는 Python 환경·모델 캐시
$Poc     = 'C:\KKokKKok\local-test\KkokKkok-PoC'
$Backend = 'C:\KKokKKok\local-test\kkokkkok-backend'
$Jdk17   = 'C:\Program Files\Java\jdk-17.0.11'
$Logs    = Join-Path $Local 'logs'
$PidFile = Join-Path $Local 'pids.json'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Test-Port([int]$Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
function Wait-Http([string]$Url, [int[]]$Ok, [int]$TimeoutSec, [int]$ProcId) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $false }
        try {
            $code = (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5).StatusCode
        } catch {
            $code = 0
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        }
        if ($Ok -contains $code) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}
function Start-Logged([string]$Name, [string]$File, [string[]]$ArgList, [string]$WorkDir, [hashtable]$Env) {
    foreach ($k in $Env.Keys) { Set-Item -Path "Env:$k" -Value ([string]$Env[$k]) }
    try {
        $p = Start-Process -FilePath $File -ArgumentList $ArgList -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $Logs "$Name.out.log") -RedirectStandardError (Join-Path $Logs "$Name.err.log")
    } finally {
        foreach ($k in $Env.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
    }
    return $p
}

# --- 사전 확인 -------------------------------------------------------------
$ports = if ($Legacy) { 8091, 3001, 8098 } else { 3001, 8098 }
foreach ($port in $ports) {
    if (Test-Port $port) { throw "포트 $port 가 이미 사용 중입니다. 먼저 stop.ps1 을 실행하세요." }
}
if (-not $Legacy) {
    if (-not (Test-Path (Join-Path $Research 'analysis-server.mjs'))) { throw "Research PoC 분석 서버가 없습니다: $Research" }
    $researchEnv = Join-Path $Research '.env'
    if (-not ((Test-Path $researchEnv) -and (Select-String -Path $researchEnv -Pattern '^\s*ANTHROPIC_API_KEY\s*=\s*\S' -Quiet))) {
        Write-Warning "$researchEnv 에 ANTHROPIC_API_KEY 가 없습니다. 서버는 뜨지만 사진 분석은 실패합니다."
    }
}
$secretsPath = Join-Path $Local 'secrets.json'
if (-not (Test-Path $secretsPath)) { throw "secrets.json 이 없습니다: $secretsPath" }
$secrets = Get-Content $secretsPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($k in 'KAKAO_APP_ID', 'KAKAO_REST_API_KEY', 'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET') {
    if (-not "$($secrets.$k)".Trim()) { throw "secrets.json 에 $k 값이 없습니다." }
}
$openAi = "$($secrets.OPENAI_API_KEY)".Trim()
if (-not $openAi) { Write-Warning 'secrets.json 에 OPENAI_API_KEY 가 없습니다. 로그인·지도는 되지만 사진 분석과 보호 편집은 실패합니다.' }

$envLocal = @{}
Get-Content (Join-Path $Poc '.env.local') -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $envLocal[$Matches[1]] = $Matches[2].Trim() }
}
foreach ($k in 'ANALYSIS_API_KEY', 'ANALYSIS_VISION_STAGE_KEY') {
    if (-not $envLocal[$k]) { throw ".env.local 에 $k 값이 없습니다." }
}

$pids = [ordered]@{}

# --- 1. OCR·객체 탐지 sidecar (8091) ----------------------------------------
$python = Join-Path $Poc 'private-data\.venv-analysis\Scripts\python.exe'
$useSidecar = $Legacy -and (-not $NoSidecar) -and (Test-Path $python)
if (-not $Legacy) {
    Write-Host '[1/3] sidecar 건너뜀 (Research PoC 분석 서버가 OCR·객체 탐지를 직접 실행합니다)'
} elseif ($useSidecar) {
    $models = Join-Path $Poc 'private-data\models'
    New-Item -ItemType Directory -Force -Path "$models\huggingface", "$models\paddle" | Out-Null
    Write-Host '[1/3] sidecar 시작 (첫 실행은 모델 약 750MB 다운로드로 오래 걸립니다)...'
    $p = Start-Logged 'sidecar' $python @('-m', 'uvicorn', 'app:app', '--app-dir', (Join-Path $Poc 'analysis-service'), '--host', '127.0.0.1', '--port', '8091') $Poc @{
        ANALYSIS_VISION_STAGE_KEY = $envLocal['ANALYSIS_VISION_STAGE_KEY']
        HF_HOME = "$models\huggingface"; HF_HUB_DISABLE_XET = '1'
        PADDLE_HOME = "$models\paddle"; PADDLE_PDX_CACHE_HOME = "$models\paddle"
        PYTHONUTF8 = '1'; PYTHONIOENCODING = 'utf-8'
    }
    $pids.sidecar = $p.Id
    if (Wait-Http 'http://127.0.0.1:8091/health' @(200) 1800 $p.Id) { Write-Host '      sidecar 준비됨' }
    else { Write-Warning "sidecar 가 준비되지 않았습니다. $Logs\sidecar.err.log 를 확인하세요. (GPT 분석은 sidecar 없이도 동작)" }
} else {
    Write-Host '[1/3] sidecar 건너뜀 (OCR·객체 탐지 단계는 "사용 안 함"으로 표시됩니다)'
}

# --- 2. 분석 서버 (3001) -----------------------------------------------------
Write-Host '[2/3] 분석 서버 시작...'
$nodeEnv = @{ OPENAI_API_KEY = $openAi }
if (-not $useSidecar) { $nodeEnv.ANALYSIS_VISION_STAGE_URL = '' }
$node = (Get-Command node).Source
if ($Legacy) {
    $p = Start-Logged 'analysis' $node @('scripts/start-local.cjs', 'start', '--port', '3001') $Poc $nodeEnv
} else {
    # 사진·분석 기록은 이 폴더의 analysis-research 아래에 둡니다. 서버 간 키는 백엔드와 같은 값입니다.
    $p = Start-Logged 'analysis' $node @('analysis-server.mjs') $Research @{
        ANALYSIS_API_KEY = $envLocal['ANALYSIS_API_KEY']; ANALYSIS_PORT = '3001'
        ANALYSIS_DATA_DIR = (Join-Path $Local 'analysis-research')
        KKOK_LEGACY_ROOT = $ResearchDeps
    }
}
$pids.analysis = $p.Id
if (Wait-Http 'http://127.0.0.1:3001/' @(200, 204, 301, 302, 307, 308, 401, 403, 404) 120 $p.Id) { Write-Host '      분석 서버 준비됨' }
else { Write-Warning "분석 서버가 준비되지 않았습니다. $Logs\analysis.err.log 를 확인하세요." }

# --- 3. 백엔드 (8098) --------------------------------------------------------
Write-Host '[3/3] 백엔드 시작 (첫 실행은 Gradle 다운로드·빌드로 몇 분 걸립니다)...'
$p = Start-Logged 'backend' "$env:ComSpec" @('/c', '.\gradlew.bat', 'bootRun', '--no-daemon', '--console=plain') $Backend @{
    JAVA_HOME = $Jdk17
    SPRING_PROFILES_ACTIVE = 'local'; SERVER_ADDRESS = '127.0.0.1'; PORT = '8098'
    AUTH_ENABLED = 'true'
    KAKAO_APP_ID = $secrets.KAKAO_APP_ID; KAKAO_REST_API_KEY = $secrets.KAKAO_REST_API_KEY
    NAVER_CLIENT_ID = $secrets.NAVER_CLIENT_ID; NAVER_CLIENT_SECRET = $secrets.NAVER_CLIENT_SECRET
    ANALYSIS_PROVIDER = 'node'; NODE_ANALYSIS_BASE_URL = 'http://127.0.0.1:3001'
    NODE_ANALYSIS_API_KEY = $envLocal['ANALYSIS_API_KEY']
    NODE_ANALYSIS_EXTERNAL_IMAGE_CONSENT = 'true'; NODE_ANALYSIS_TIMEOUT_SECONDS = '120'
    EDITING_PROVIDER = 'openai'; OPENAI_API_KEY = $openAi
    DB_URL = 'jdbc:h2:file:C:/KKokKKok/kkokkkok-local/backend/db/backend'
    ASSET_STORAGE_ROOT = 'C:/KKokKKok/kkokkkok-local/backend/assets'
}
$pids.backend = $p.Id
$pids | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8
if (Wait-Http 'http://127.0.0.1:8098/api/auth/me' @(401) 600 $p.Id) { Write-Host '      백엔드 준비됨 (/api/auth/me -> 401)' }
else { Write-Warning "백엔드가 준비되지 않았습니다. $Logs\backend.out.log / backend.err.log 를 확인하세요." }

Write-Host ''
Write-Host '포트 상태:'
foreach ($port in 8091, 3001, 8098) { Write-Host ("  {0} : {1}" -f $port, $(if (Test-Port $port) { '열림' } else { '닫힘' })) }
Write-Host '휴대폰 연결 후:  adb reverse tcp:8098 tcp:8098   (USB를 다시 꽂으면 다시 실행)'
Write-Host '끄기:  .\stop.ps1'
