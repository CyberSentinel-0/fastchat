# The Beginner's Guide: Deploying FastChat on macOS

> Welcome. If you have never used Cloudflare or terminal commands before, this guide provides a step-by-step walkthrough for macOS. Follow each step in order to deploy your own private real-time chat platform under your own Cloudflare account and your own chosen domain name.

---

## How Cloudflare Naming Works

Before starting, here is how naming works on Cloudflare's free tier:
1. **Your Frontend Website (`public/`)**:  
   Runs on Cloudflare Pages. You pick your own unique project name (for example: `alex-chat`, `fastchat-live`, `my-private-space`).  
   Your website URL will be:  
   `https://<YOUR-CHOSEN-NAME>.pages.dev`  
   *(Note: Names on `pages.dev` are globally unique across all of Cloudflare, just like website `.com` domain names, so choose a name unique to you).*

2. **Your Backend API and Database (`src/`)**:  
   Runs on Cloudflare Workers with SQLite Durable Objects.  
   When you deploy, Cloudflare assigns you your own worker subdomain, for example:  
   `https://fastchat-backend.<YOUR-SUBDOMAIN>.workers.dev`

---

## Step 1: Install Required Tools on Your Mac

### 1.1 Open Terminal on Mac
- Press `Cmd + Space` to open Spotlight Search.
- Type `Terminal` and press Enter.
- A command window will open. This is where you run commands.

### 1.2 Check if Node.js is Installed
In your Terminal, copy and paste this command, then press Enter:
```bash
node -v
```
- If it shows `v20.x.x` or `v22.x.x`, you are ready. Proceed to Step 2.
- If it says `command not found: node`, install Node.js using Homebrew:

```bash
# 1. Install Homebrew (Mac official package manager) if you do not have it:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Node.js:
brew install node
```

Verify it installed by checking:
```bash
node -v
npm -v
```

---

## Step 2: Create Your Free Cloudflare Account

1. Go to https://dash.cloudflare.com/sign-up in your browser.
2. Sign up with your email and choose a password.
3. You do not need a credit card. Cloudflare provides free Workers, free Pages, and free SQLite Durable Objects.

---

## Step 3: Open the Project in Terminal

1. In Terminal, navigate (`cd`) into your project folder.
   *(Tip: You can type `cd ` with a space, then drag and drop the project folder from Finder into the Terminal window and press Enter).*
   ```bash
   cd ~/Downloads/fastchat
   ```
2. Install project dependencies by running:
   ```bash
   npm install
   ```

---

## Step 4: Login to Cloudflare from Mac Terminal

Link your Terminal to your own Cloudflare account:

```bash
npx wrangler login
```

- A browser window will automatically pop open asking you to authorize Wrangler.
- Click "Allow" or "Authorize".
- Switch back to Terminal. It will confirm your login.

---

## Step 5: Deploy Your Backend Worker

In your Terminal, run:
```bash
npm run deploy:backend
```
*(Or manually: `npx wrangler deploy`)*

### What happens:
- Wrangler compiles `src/worker.js`.
- It sets up your SQLite Durable Objects (`CHAT_ROOM`, `USER_REGISTRY`).
- It uploads everything to Cloudflare's edge network.

### Output
At the end of the deployment, Wrangler will print your live backend URL:
```text
Uploaded fastchat-backend (1.45 sec)
Deployed fastchat-backend triggers (0.82 sec)
  https://fastchat-backend.YOUR-ACCOUNT-SUBDOMAIN.workers.dev
```

**IMPORTANT**: Copy that URL. You will paste it into the frontend configuration in the next step.

*(Note: If you want to change the worker name from `fastchat-backend` to something else, you can edit line 2 of `wrangler.toml` at any time).*

---

## Step 6: Connect Your Frontend to Your Backend

Now tell your frontend where your backend is located:

1. Open `public/app.js` in your text editor (VS Code, Cursor, or TextEdit).
2. Look around line 53. You will see:
   ```javascript
   // ============================================================================
   // BACKEND CONFIGURATION
   // Replace this with YOUR deployed Cloudflare Worker URL from `npx wrangler deploy`!
   // Example: const API_BASE = 'https://my-backend.<your-subdomain>.workers.dev';
   // ============================================================================
   const API_BASE = 'https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev';
   ```
3. Replace that placeholder URL with your actual Worker URL that you copied in Step 5:
   ```javascript
   const API_BASE = 'https://fastchat-backend.YOUR-ACCOUNT-SUBDOMAIN.workers.dev';
   ```
4. Save the file (`Cmd + S`).

---

## Step 7: Deploy Your Frontend (Choose Your Own Website Name)

Back in your Mac Terminal, run:
```bash
npm run deploy:frontend
```
*(Or manually: `npx wrangler pages deploy public --branch=main --commit-dirty=true`)*

### What to expect:
1. Wrangler will ask for a project name:
   ```text
   Enter the name of your Pages project: ...
   ```
   Type your own unique project name (for example: `alex-chat` or `fastchat-sam` or `my-private-chat`).
2. If it is a new project, Wrangler will ask:
   ```text
   Project 'alex-chat' does not exist. Would you like to create it?
   ```
   Press Enter (Yes).
3. It will ask for the production branch:
   Press Enter (defaults to `main`).
4. Wrangler will upload all files from `public/` (HTML, CSS, JS, icons).

### Result
Terminal will print:
```text
Deployment complete! Take a peek over at:
https://YOUR-CHOSEN-NAME.pages.dev
```

Open that link in Safari or Chrome on your Mac or iPhone. Your site is live worldwide.

---

## Step 8: Testing Your Live Site

1. Open `https://YOUR-CHOSEN-NAME.pages.dev` in your browser.
2. In the Login screen:
   - Enter a Username (for example, `alex`).
   - Enter a Password.
   - Click Enter FastChat (or press Enter).
   - Since it is a new account, it automatically registers you and logs you in.
3. Open a Private/Incognito window in your browser.
   - Go to `https://YOUR-CHOSEN-NAME.pages.dev`.
   - Register a second user (for example, `sam`).
4. In Alex's window, click "+ Add Contact" and type `sam`.
5. Now start chatting. You will have instant message delivery, live typing peek, WebRTC audio/video calls, and synchronized watch parties.

---

## Making Changes in the Future

Whenever you or your AI assistant makes an edit to any file in `public/` or `src/`, redeploying is done via:

```bash
# To deploy backend:
npm run deploy:backend

# To deploy frontend (replace <YOUR-PROJECT-NAME> with your project name):
npx wrangler pages deploy public --project-name=YOUR-PROJECT-NAME --branch=main --commit-dirty=true
```

---

## Live Logs and Debugging

To see incoming requests and WebSocket events live from Cloudflare:
```bash
npx wrangler tail
```

---

## Admin Controls and Site Management

FastChat comes with built-in administrative capabilities. For security, all admin endpoints are completely locked until you set your own private `ADMIN_KEY` secret.

### 1. Set Up Your Admin Key

In your Terminal (inside the project folder), run:
```bash
npx wrangler secret put ADMIN_KEY
```
Cloudflare will prompt:
```text
Enter a secret value: ********
```
Type any private passcode or passphrase you want (for example, `MySecretMasterKey2026`). Press Enter.

Now your Cloudflare Worker is armed with your master admin key.

---

### 2. Using the Interactive Admin Tool

We provide an interactive script that lets you manage your site without typing raw API requests.

On macOS / Linux:
```bash
chmod +x admin.sh
./admin.sh
```

On Windows (PowerShell):
```powershell
.\admin.ps1
```

The script will prompt for your `ADMIN_KEY` and present an interactive menu:
1. **List all users and passwords**: Shows every registered user, their password, and registration date in a clean table.
2. **Change a user's password**: Resets or changes any user account password.
3. **Delete a user and their data**: Deletes a specific user account, their contact list, presence, and active sessions.
4. **Wipe ALL chat rooms and database (Reset All)**: Permanently wipes every message, chat room, user, and contact across the entire system.
5. **Disable new user registration**: Closes registration so no new accounts can be created.
6. **Enable new user registration**: Opens registration so new visitors can sign up.

---

### 3. Alternative: Direct Terminal Commands (curl)

If you prefer running direct commands in Terminal, replace `<YOUR-KEY>` with your `ADMIN_KEY` and `<YOUR-WORKER-URL>` with your Worker URL:

#### View all usernames and passwords:
```bash
curl -H "X-Admin-Key: <YOUR-KEY>" https://<YOUR-WORKER-URL>/api/admin/users
```

#### Change a user's password:
```bash
curl -X POST \
  -H "X-Admin-Key: <YOUR-KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username":"alex","newPassword":"NewSecurePassword123"}' \
  https://<YOUR-WORKER-URL>/api/admin/password
```

#### Delete a specific user:
```bash
curl -X DELETE \
  -H "X-Admin-Key: <YOUR-KEY>" \
  https://<YOUR-WORKER-URL>/api/admin/users/alex
```

#### Wipe all chats, messages, and users (Full Reset):
```bash
curl -X POST \
  -H "X-Admin-Key: <YOUR-KEY>" \
  https://<YOUR-WORKER-URL>/api/admin/reset
```

#### Disable new user registrations (Close signups):
```bash
curl -X POST \
  -H "X-Admin-Key: <YOUR-KEY>" \
  https://<YOUR-WORKER-URL>/api/admin/registration/off
```

#### Re-enable new user registrations (Open signups):
```bash
curl -X POST \
  -H "X-Admin-Key: <YOUR-KEY>" \
  https://<YOUR-WORKER-URL>/api/admin/registration/on
```

---

You now have your own private, edge-native, real-time chat platform running completely under your own Cloudflare account with your own custom site name.
