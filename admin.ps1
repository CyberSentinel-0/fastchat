# ==============================================================================
# FastChat Admin CLI Tool (Windows PowerShell)
# ==============================================================================

$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "         FastChat Admin Manager           " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Determine Worker URL
$workerUrl = ""
if (Test-Path "public\app.js") {
    $line = Get-Content "public\app.js" | Select-String "const API_BASE ="
    if ($line) {
        $extracted = [regex]::Match($line.Line, "'([^']+)'").Groups[1].Value
        if ($extracted -and -not ($extracted.Contains("YOUR-WORKER-NAME"))) {
            $workerUrl = $extracted
        }
    }
}

if (-not $workerUrl) {
    $workerUrl = Read-Host "Enter your Cloudflare Worker URL (e.g. https://fastchat-backend.yourname.workers.dev)"
}

$workerUrl = $workerUrl.TrimEnd('/')

Write-Host "Target Backend: $workerUrl" -ForegroundColor Green
Write-Host ""

# 2. Prompt for Admin Key
$adminKey = Read-Host "Enter your ADMIN_KEY (secret code)"
Write-Host ""

if (-not $adminKey) {
    Write-Host "Error: ADMIN_KEY cannot be empty." -ForegroundColor Red
    exit 1
}

$headers = @{
    "X-Admin-Key" = $adminKey
}

while ($true) {
    Write-Host "------------------------------------------"
    Write-Host "Select an action:"
    Write-Host "1) List all users and passwords"
    Write-Host "2) Change a user's password"
    Write-Host "3) Delete a user and their data"
    Write-Host "4) Wipe ALL chat rooms and database (Reset All)"
    Write-Host "5) Disable new user registration (registration OFF)"
    Write-Host "6) Enable new user registration (registration ON)"
    Write-Host "7) Exit"
    Write-Host "------------------------------------------"
    $option = Read-Host "Option (1-7)"
    Write-Host ""

    switch ($option) {
        "1" {
            Write-Host "Fetching all users and passwords..." -ForegroundColor Yellow
            try {
                $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/users" -Headers $headers -Method Get
                if ($res.users -and $res.users.Count -gt 0) {
                    Write-Host "Total Users: $($res.count)" -ForegroundColor Green
                    $res.users | Format-Table -Property username, password, created -AutoSize
                } else {
                    Write-Host "No users registered yet." -ForegroundColor DarkGray
                }
            } catch {
                Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
            }
            Write-Host ""
        }
        "2" {
            $targetUser = Read-Host "Enter username"
            $newPass = Read-Host "Enter new password"
            Write-Host ""
            try {
                $body = @{ username = $targetUser; newPassword = $newPass } | ConvertTo-Json
                $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/password" -Headers $headers -Method Post -Body $body -ContentType "application/json"
                Write-Host "Password changed successfully for: $targetUser" -ForegroundColor Green
            } catch {
                Write-Host "Failed to change password: $($_.Exception.Message)" -ForegroundColor Red
            }
            Write-Host ""
        }
        "3" {
            $targetUser = Read-Host "Enter username to delete"
            $confirm = Read-Host "Are you sure you want to delete user '$targetUser'? (yes/no)"
            if ($confirm -eq "yes") {
                try {
                    $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/users/$targetUser" -Headers $headers -Method Delete
                    Write-Host "User deleted successfully: $targetUser" -ForegroundColor Green
                } catch {
                    Write-Host "Failed to delete user: $($_.Exception.Message)" -ForegroundColor Red
                }
            } else {
                Write-Host "Deletion cancelled." -ForegroundColor DarkGray
            }
            Write-Host ""
        }
        "4" {
            Write-Host "WARNING: This will permanently delete ALL messages, chats, and users." -ForegroundColor Red
            $confirm = Read-Host "Type 'WIPE' to confirm full database reset"
            if ($confirm -eq "WIPE") {
                try {
                    $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/reset" -Headers $headers -Method Post
                    Write-Host "All messages, chats, and accounts wiped successfully." -ForegroundColor Green
                } catch {
                    Write-Host "Failed to reset: $($_.Exception.Message)" -ForegroundColor Red
                }
            } else {
                Write-Host "Wipe cancelled." -ForegroundColor DarkGray
            }
            Write-Host ""
        }
        "5" {
            Write-Host "Disabling new account creation..." -ForegroundColor Yellow
            try {
                $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/registration/off" -Headers $headers -Method Post
                Write-Host "Registration is now CLOSED. Nobody can sign up." -ForegroundColor Green
            } catch {
                Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
            }
            Write-Host ""
        }
        "6" {
            Write-Host "Enabling new account creation..." -ForegroundColor Yellow
            try {
                $res = Invoke-RestMethod -Uri "$workerUrl/api/admin/registration/on" -Headers $headers -Method Post
                Write-Host "Registration is now OPEN. Anyone can sign up." -ForegroundColor Green
            } catch {
                Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red
            }
            Write-Host ""
        }
        "7" {
            Write-Host "Exiting."
            exit 0
        }
        default {
            Write-Host "Invalid option. Please choose 1-7." -ForegroundColor Yellow
        }
    }
}
