---
description: Deploy the FastChat static frontend to Cloudflare Pages
---

# Deploy Frontend Pages Workflow

Follow these steps to deploy the FastChat frontend website:

1. **Verify Backend Connection**:
   Check `public/app.js` around line 53 to verify that `API_BASE` points to your active deployed Cloudflare Worker backend:
   ```javascript
   const API_BASE = 'https://<your-worker-name>.<your-subdomain>.workers.dev';
   ```

2. **Deploy to Cloudflare Pages (Production Main Branch)**:
   ```bash
   npx wrangler pages deploy public --branch=main --commit-dirty=true
   ```
   > **CRITICAL**: Always include `--branch=main --commit-dirty=true` to ensure the live production site updates immediately! Choose your own unique project name when prompted.

3. **Verify the Live Website**:
   Open `https://<your-project-name>.pages.dev` in your browser and verify login and chat functionality.
