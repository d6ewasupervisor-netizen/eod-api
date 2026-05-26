# Deploy review-and-learn routes to Railway (eod-api production).
# Prereq: railway login  (OAuth session must be fresh)
#
# Usage:
#   cd c:\Users\tgaut\eod-api
#   .\scripts\deploy-review-routes.ps1
# Optional — set shared HMAC secret on Railway + print for flow-automation .env:
#   .\scripts\deploy-review-routes.ps1 -SetReviewSecret

param(
  [switch]$SetReviewSecret
)

$ErrorActionPreference = 'Stop'
$ProjectId = '5bc0629e-2ebb-49f2-9e13-8b878a16bf93'
$Environment = 'production'
$ServiceId = '7478ebb4-8bae-4e30-a2d5-9cb41723d2e2'

Write-Host 'Checking Railway auth...' -ForegroundColor Cyan
railway whoami
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Run: railway login' -ForegroundColor Yellow
  exit 1
}

if ($SetReviewSecret) {
  $secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  Write-Host "Setting REVIEW_REQUEST_SECRET on Railway ($Environment)..." -ForegroundColor Cyan
  railway variable set "REVIEW_REQUEST_SECRET=$secret" `
    --project $ProjectId `
    --environment $Environment `
    --service $ServiceId
  Write-Host ''
  Write-Host 'Add the same value to flow-automation .env:' -ForegroundColor Green
  Write-Host "REVIEW_REQUEST_SECRET=$secret"
  Write-Host ''
}

Write-Host 'Deploying eod-api (review routes + migration 006)...' -ForegroundColor Cyan
railway up --detach `
  --project $ProjectId `
  --environment $Environment `
  --service $ServiceId

Write-Host 'Done. Migration 006 runs on boot. Verify:' -ForegroundColor Green
Write-Host '  railway logs --project $ProjectId --environment $Environment --service $ServiceId'
