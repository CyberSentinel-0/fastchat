---
description: Deploy the FastChat Cloudflare Worker backend and SQLite Durable Objects
---

# Deploy Backend Worker Workflow

Follow these steps to deploy the FastChat backend:

1. **Verify Wrangler Login**:
   ```bash
   npx wrangler whoami
   ```
   If not logged in, run:
   ```bash
   npx wrangler login
   ```

2. **Deploy the Worker & Durable Objects**:
   ```bash
   npx wrangler deploy
   ```

3. **Verify Deployment Output**:
   Ensure the output displays the active `*.workers.dev` URL:
   ```text
   Uploaded fastchat-backend (x.xx sec)
   Deployed fastchat-backend triggers (x.xx sec)
     https://fastchat-backend.<subdomain>.workers.dev
   ```

4. **Update Frontend API Base (if URL changed)**:
   If the worker URL is newly assigned or changed, update `public/app.js` at line 53:
   ```javascript
   const API_BASE = 'https://fastchat-backend.<subdomain>.workers.dev';
   ```
