[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$secretDirectory = Join-Path $env:APPDATA 'tunnel-client'
$secretPath = Join-Path $secretDirectory 'stugu-chatgpt.key.dpapi'

New-Item -ItemType Directory -Force -Path $secretDirectory | Out-Null

Write-Host 'Paste the OpenAI runtime key for the Stugu tunnel.'
Write-Host 'The key is hidden while you type and is encrypted for this Windows user.'
$secureKey = Read-Host 'Runtime key' -AsSecureString

if ($secureKey.Length -lt 20) {
    throw 'The runtime key looks too short.'
}

$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ($plainKey -notmatch '^sk-\S+$') {
        throw 'The runtime key does not look like an OpenAI API key.'
    }

    $encryptedKey = ConvertFrom-SecureString $secureKey
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($secretPath, $encryptedKey, $utf8WithoutBom)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    Remove-Variable plainKey -ErrorAction SilentlyContinue
}

$currentAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $secretPath /inheritance:r /grant:r "${currentAccount}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'The key was encrypted, but restricting its file permissions failed.'
}

Write-Host 'Saved securely. You can close this window.' -ForegroundColor Green
Read-Host 'Press Enter to close' | Out-Null
