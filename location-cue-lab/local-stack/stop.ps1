# 꼭꼭 로컬 테스트 서버 종료: start.ps1 이 띄운 프로세스 트리와 8098/3001/8091 포트의 서버를 끕니다.
$Local   = $PSScriptRoot
$PidFile = Join-Path $Local 'pids.json'

if (Test-Path $PidFile) {
    $pids = Get-Content $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in 'backend', 'analysis', 'sidecar') {
        $id = $pids.$name
        if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
            & taskkill.exe /PID $id /T /F *> $null
            Write-Host "$name 종료 (PID $id)"
        }
    }
    Remove-Item $PidFile -Confirm:$false
}

# 트리 종료에서 빠진 프로세스(예: Gradle 이 따로 띄운 JVM)를 포트 기준으로 정리. 서버 종류의 프로세스만 대상.
foreach ($port in 8098, 3001, 8091) {
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($id in $owners) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match '^(java|node|python)$') {
            & taskkill.exe /PID $id /T /F *> $null
            Write-Host "포트 $port 의 $($proc.ProcessName) 종료 (PID $id)"
        } elseif ($proc) {
            Write-Warning "포트 $port 를 $($proc.ProcessName) (PID $id) 가 쓰고 있어 건드리지 않았습니다."
        }
    }
}

# 분석 워커 잠금 파일이 남아 있으면 다음 시작이 막히므로 정리
$lock = Join-Path $Local 'analysis\feature-discovery.sqlite.worker.lock'
if (Test-Path $lock) { Remove-Item $lock -Confirm:$false }
Write-Host '완료'
