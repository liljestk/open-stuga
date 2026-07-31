[CmdletBinding()]
param(
    [switch] $Doctor
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$clientPath = Join-Path $env:LOCALAPPDATA 'OpenAI\tunnel-client\v0.0.10\tunnel-client.exe'
$secretPath = Join-Path $env:APPDATA 'tunnel-client\stugu-chatgpt.key.dpapi'

if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
    throw "Tunnel client not found at $clientPath"
}
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'The encrypted runtime key is missing. Run save-stugu-tunnel-key.ps1 first.'
}

$encryptedKey = [IO.File]::ReadAllText($secretPath).Trim()
$secureKey = ConvertTo-SecureString $encryptedKey
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    Push-Location $repositoryRoot
    try {
        if ($Doctor) {
            & $clientPath doctor --profile stugu-chatgpt --explain
        }
        else {
            & $clientPath run --profile stugu-chatgpt
        }
        $clientExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($clientExitCode -ne 0) {
        throw "Tunnel client exited with code $clientExitCode."
    }
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
