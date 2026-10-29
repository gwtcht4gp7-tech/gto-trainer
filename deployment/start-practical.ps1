param([Parameter(Mandatory=$true)][string]$DataRoot,[int]$Port=8900,[int]$SolverPort=8892,[int]$HeroSeat=0,[int]$SolverBudget=2900,[switch]$NoTraining)
$ErrorActionPreference='Stop'
# Practical testing: preserve profiles/logs, use no training or learned model.
$NoTraining=$true
$env:POKER_SOLVER_MODE='practical'
$repo=Split-Path -Parent $PSScriptRoot
$pythonExe = & py -3 -c 'import sys; print(sys.executable)'
$collectorData=Join-Path $DataRoot '..\pokerist-export\data'
$runtime=Join-Path $DataRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$live=Get-ChildItem -LiteralPath $collectorData -Filter '*.jsonl' | Sort-Object LastWriteTime | Select-Object -Last 1
if(-not $live){throw '没有采集文件，请先启动 Pokerist 采集器。'}
$bridgeFile=Join-Path $repo 'tools\pokerist-bridge.js'
$solverFile=Join-Path $repo 'tools\solver\server.py'
$trainerFile=Join-Path $repo 'tools\solver\train.py'
$reviewFile=Join-Path $repo 'tools\solver\review.py'
$servicesFile=Join-Path $runtime 'services.json'
if(Test-Path -LiteralPath $servicesFile){
    $previous=Get-Content -LiteralPath $servicesFile -Raw | ConvertFrom-Json
    if($previous.reviewerPid){
        $oldReviewer=Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.reviewerPid)" -ErrorAction SilentlyContinue
        if($oldReviewer -and $oldReviewer.CommandLine -like "*$reviewFile*"){
            Stop-Process -Id $oldReviewer.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    if($previous.trainerPid){
        $oldTrainer=Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.trainerPid)" -ErrorAction SilentlyContinue
        if($oldTrainer -and $oldTrainer.CommandLine -like "*$trainerFile*"){
            Stop-Process -Id $oldTrainer.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
# Only replace processes proven to be this bridge or solver.
foreach($endpoint in @(@{Port=$Port;File=$bridgeFile},@{Port=$SolverPort;File=$solverFile})){
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $endpoint.Port -ErrorAction SilentlyContinue)
    foreach($procId in @($listeners.OwningProcess | Select-Object -Unique)){
        $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
        if($proc.CommandLine -notlike "*$($endpoint.File)*"){
            throw "端口 $($endpoint.Port) 被其他程序占用，未关闭该程序。"
        }
        try{Stop-Process -Id $procId -Force}catch{
            if(Get-Process -Id $procId -ErrorAction SilentlyContinue){throw}
        }
    }
}
$env:SOLVER_PORT=[string]$SolverPort
$env:SOLVER_LOG=Join-Path $runtime 'solver-diagnostics.jsonl'
$modelDir=Join-Path $DataRoot 'model'
New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
$trainingModel=Join-Path $modelDir 'blueprint.sqlite'
$env:POKER_BLUEPRINT=Join-Path $modelDir 'serving.sqlite'
if(-not $NoTraining -and (Test-Path -LiteralPath $trainingModel) -and -not (Test-Path -LiteralPath $env:POKER_BLUEPRINT)){
    & $pythonExe -c 'import sys; sys.path.insert(0,sys.argv[1]); from evaluate import freeze_model; freeze_model(sys.argv[2],sys.argv[3])' (Split-Path $trainerFile) $trainingModel $env:POKER_BLUEPRINT
    if($LASTEXITCODE -ne 0){throw '线上基础策略快照创建失败'}
}
$env:POKER_PRIORITY=Join-Path $runtime 'realtime.priority'
$trainingStatus=Join-Path $modelDir 'training-status.json'
$trainerProc=$null
if($NoTraining){
    $trainingState=if(Test-Path -LiteralPath $trainingStatus){Get-Content -LiteralPath $trainingStatus -Raw|ConvertFrom-Json}else{@{episodes=0;storedInformationSets=0;status='disabled';updatedAt=0}}
    $trainingState.status='disabled';$trainingState.updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $trainingState|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $trainingStatus -Encoding utf8
}
if(-not $NoTraining){
    $trainerArgs=@('-u',('"'+$trainerFile+'"'),'--model',('"'+$trainingModel+'"'),
        '--status',('"'+$trainingStatus+'"'),'--priority',('"'+$env:POKER_PRIORITY+'"'),
        '--cases',('"'+(Join-Path $DataRoot 'advice-live.jsonl')+'"'),
        '--seed-cases',('"'+(Join-Path $DataRoot 'fullstreet-cases.json')+'"'),
        '--review-cases',('"'+(Join-Path $DataRoot 'training-priorities.jsonl')+'"'))
    $trainerProc=Start-Process -FilePath $pythonExe -ArgumentList $trainerArgs -WorkingDirectory (Split-Path $trainerFile) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'trainer.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'trainer.stderr.log')
    try{$trainerProc.PriorityClass='Idle'}catch{}
}
$solverProc=Start-Process -FilePath $pythonExe -ArgumentList @('-u',('"'+$solverFile+'"')) `
    -WorkingDirectory (Split-Path $solverFile) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtime 'solver.stdout.log') -RedirectStandardError (Join-Path $runtime 'solver.stderr.log')
$healthy=$false
for($attempt=0;$attempt -lt 15;$attempt++){
    try{
        $health=Invoke-RestMethod "http://127.0.0.1:$SolverPort/health" -TimeoutSec 2
        if($health.version -eq '20261029-practical-test-v1'){$healthy=$true;break}
    }catch{}
    Start-Sleep -Milliseconds 300
}
if(-not $healthy){throw "分析服务启动失败，查看 $runtime\solver.stderr.log"}
$bridgeArgs=@(('"'+$bridgeFile+'"'),'--file',('"'+$live.FullName+'"'),'--warm-start',
    '--port',[string]$Port,'--solver',[string]$SolverPort,'--quiet',
    '--profiles',('"'+(Join-Path $DataRoot 'player-profiles.json')+'"'),
    '--training-status',('"'+$trainingStatus+'"'),
    '--observations',('"'+(Join-Path $DataRoot 'observations.jsonl')+'"'),
    '--review-status',('"'+(Join-Path $DataRoot 'review-status.json')+'"'),
    '--log',('"'+(Join-Path $DataRoot 'advice-live.jsonl')+'"'))
if($HeroSeat -gt 0){$bridgeArgs+=@('--hero-seat',[string]$HeroSeat)}
if($SolverBudget -gt 0){$bridgeArgs+=@('--solver-budget',[string]$SolverBudget)}
$nodeExe=(Get-Command node -ErrorAction Stop).Source
$bridgeProc=Start-Process -FilePath $nodeExe -ArgumentList $bridgeArgs -WorkingDirectory $repo `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'bridge.stdout.log') `
    -RedirectStandardError (Join-Path $runtime 'bridge.stderr.log')
$reviewArgs=@('-u',('"'+$reviewFile+'"'),'--observations',('"'+(Join-Path $DataRoot 'observations.jsonl')+'"'),
    '--output',('"'+(Join-Path $DataRoot 'reviews.jsonl')+'"'),'--status',('"'+(Join-Path $DataRoot 'review-status.json')+'"'),
    '--priorities',('"'+(Join-Path $DataRoot 'training-priorities.jsonl')+'"'),
    '--model',('"'+$env:POKER_BLUEPRINT+'"'),'--priority',('"'+$env:POKER_PRIORITY+'"'))
$reviewProc=$null
if(-not $NoTraining){
    $reviewProc=Start-Process -FilePath $pythonExe -ArgumentList $reviewArgs -WorkingDirectory (Split-Path $reviewFile) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'reviewer.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'reviewer.stderr.log')
    try{$reviewProc.PriorityClass='Idle'}catch{}
}else{
    @{status='disabled';updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();completed=0;excluded=0} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot 'review-status.json') -Encoding utf8
}
@{startedAt=(Get-Date).ToString('o');bridgePid=$bridgeProc.Id;solverPid=$solverProc.Id;
  trainerPid=$(if($trainerProc){$trainerProc.Id}else{$null});reviewerPid=$(if($reviewProc){$reviewProc.Id}else{$null});
  modelFile=$env:POKER_BLUEPRINT;trainingModelFile=$trainingModel;
  bridgeFile=$bridgeFile;solverFile=$solverFile;port=$Port;solverPort=$SolverPort;inputFile=$live.FullName} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'services.json') -Encoding utf8
Write-Output "牌局分析已启动：http://127.0.0.1:$Port"
Write-Output "玩家档案：$DataRoot\player-profiles.json"
