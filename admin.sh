#!/bin/bash
# ==============================================================================
# FastChat Admin CLI Tool (macOS & Linux)
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "=========================================="
echo "         FastChat Admin Manager           "
echo "=========================================="
echo ""

# 1. Determine Worker URL
WORKER_URL=""
if [ -f "public/app.js" ]; then
    DETECTED_URL=$(grep "const API_BASE =" public/app.js | sed -E "s/.*'([^']+)'.*/\1/" | grep -v "YOUR-WORKER-NAME" || true)
    if [ -n "$DETECTED_URL" ]; then
        WORKER_URL="$DETECTED_URL"
    fi
fi

if [ -z "$WORKER_URL" ]; then
    read -p "Enter your Cloudflare Worker URL (e.g. https://fastchat-backend.yourname.workers.dev): " WORKER_URL
fi

WORKER_URL="${WORKER_URL%/}"

echo "Target Backend: $WORKER_URL"
echo ""

# 2. Prompt for Admin Key
read -s -p "Enter your ADMIN_KEY: " ADMIN_KEY
echo ""
echo ""

if [ -z "$ADMIN_KEY" ]; then
    echo "Error: ADMIN_KEY cannot be empty."
    exit 1
fi

while true; do
    echo "------------------------------------------"
    echo "Select an action:"
    echo "1) List all users and passwords"
    echo "2) Change a user's password"
    echo "3) Delete a user and their data"
    echo "4) Wipe ALL chat rooms and database (Reset All)"
    echo "5) Disable new user registration (registration OFF)"
    echo "6) Enable new user registration (registration ON)"
    echo "7) Exit"
    echo "------------------------------------------"
    read -p "Option (1-7): " OPTION
    echo ""

    case $OPTION in
        1)
            echo "Fetching all users..."
            RESPONSE=$(curl -s -H "X-Admin-Key: $ADMIN_KEY" "$WORKER_URL/api/admin/users")
            if command -v python3 >/dev/null 2>&1; then
                echo "$RESPONSE" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    if "users" in data:
        print(f"\nTotal Users: {data.get(\"count\", len(data[\"users\"]))}")
        print("-" * 65)
        print(f"{'USERNAME':<20} | {'PASSWORD':<20} | {'CREATED'}")
        print("-" * 65)
        for u in data["users"]:
            print(f"{u.get(\"username\", \"\"):<20} | {u.get(\"password\", \"\"):<20} | {u.get(\"created\", \"\")[:19]}")
        print("-" * 65)
    else:
        print(json.dumps(data, indent=2))
except Exception as e:
    print(data)
'
            elif command -v jq >/dev/null 2>&1; then
                echo "$RESPONSE" | jq .
            else
                echo "$RESPONSE"
            fi
            echo ""
            ;;
        2)
            read -p "Enter username: " TARGET_USER
            read -s -p "Enter new password: " NEW_PASS
            echo ""
            curl -s -X POST \
                -H "X-Admin-Key: $ADMIN_KEY" \
                -H "Content-Type: application/json" \
                -d "{\"username\":\"$TARGET_USER\",\"newPassword\":\"$NEW_PASS\"}" \
                "$WORKER_URL/api/admin/password"
            echo ""
            echo ""
            ;;
        3)
            read -p "Enter username to delete: " TARGET_USER
            read -p "Are you sure you want to delete user '$TARGET_USER'? (yes/no): " CONFIRM
            if [ "$CONFIRM" = "yes" ]; then
                curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" "$WORKER_URL/api/admin/users/$TARGET_USER"
                echo ""
            else
                echo "Cancelled."
            fi
            echo ""
            ;;
        4)
            read -p "WARNING: This will permanently delete ALL messages, chats, and users. Type 'WIPE' to confirm: " CONFIRM
            if [ "$CONFIRM" = "WIPE" ]; then
                curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" "$WORKER_URL/api/admin/reset"
                echo ""
            else
                echo "Wipe cancelled."
            fi
            echo ""
            ;;
        5)
            echo "Disabling new account creation..."
            curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" "$WORKER_URL/api/admin/registration/off"
            echo ""
            echo ""
            ;;
        6)
            echo "Enabling new account creation..."
            curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" "$WORKER_URL/api/admin/registration/on"
            echo ""
            echo ""
            ;;
        7)
            echo "Exiting."
            exit 0
            ;;
        *)
            echo "Invalid option. Please choose 1-7."
            ;;
    esac
done
