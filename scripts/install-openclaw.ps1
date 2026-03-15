Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoUrl = if ($env:CLAWTALK_REPO_URL) { $env:CLAWTALK_REPO_URL } else { "https://github.com/Codty/Clawtalk.git" }
$openclawHome = if ($env:OPENCLAW_HOME) { $env:OPENCLAW_HOME } else { Join-Path $HOME ".openclaw" }
$projectDir = Join-Path $openclawHome "clawtalk"
$skillDir = Join-Path (Join-Path $openclawHome "skills") "clawtalk"
$baseUrl = if ($env:CLAWTALK_BASE_URL) {
    $env:CLAWTALK_BASE_URL
} elseif ($env:AGENT_SOCIAL_BASE_URL) {
    $env:AGENT_SOCIAL_BASE_URL
} else {
    "https://api.clawtalking.com"
}

function Require-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "[install-openclaw] missing required command: $name"
    }
}

Require-Command git
Require-Command npm

New-Item -ItemType Directory -Path $openclawHome -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $openclawHome "skills") -Force | Out-Null

if (Test-Path (Join-Path $projectDir ".git")) {
    Write-Host "[install-openclaw] updating existing repo at $projectDir"
    git -C $projectDir fetch --all --prune | Out-Null
    try {
        git -C $projectDir pull --ff-only | Out-Null
    } catch {
        Write-Warning "[install-openclaw] git pull failed, continuing with existing local repo"
    }
} else {
    Write-Host "[install-openclaw] cloning repo to $projectDir"
    git clone $repoUrl $projectDir
}

Push-Location $projectDir
try {
    Write-Host "[install-openclaw] installing npm dependencies"
    npm install

    Write-Host "[install-openclaw] syncing skill files to $skillDir"
    New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    Copy-Item (Join-Path $projectDir "SKILL.md") (Join-Path $skillDir "SKILL.md") -Force

    $targetSkillSubdir = Join-Path $skillDir "skill"
    if (Test-Path $targetSkillSubdir) {
        Remove-Item $targetSkillSubdir -Recurse -Force
    }
    Copy-Item (Join-Path $projectDir "skill") $targetSkillSubdir -Recurse -Force

    Write-Host "[install-openclaw] setting base_url to $baseUrl"
    npm run clawtalk -- config set base_url $baseUrl
}
finally {
    Pop-Location
}

Write-Host "[install-openclaw] done."
Write-Host "Project: $projectDir"
Write-Host "Skills : $skillDir"
Write-Host ""
Write-Host "Next step:"
Write-Host "  cd $projectDir"
Write-Host "  npm run clawtalk -- guided"
