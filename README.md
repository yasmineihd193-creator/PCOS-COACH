# PCOS Coach — deployment guide

A personal wellness tracker (installable web app). This folder is everything Netlify needs.

## Deploy (about 15 minutes)

You need two free accounts: **GitHub** and **Netlify**. (Netlify's drag-and-drop box can host the app screens, but it can't install the packages the reminder backend needs — so use GitHub.)

1. **Unzip** this folder.
2. **GitHub:** create a new repository, set it to **Private**, then choose *"uploading an existing file"* and drag in *everything inside* this folder (including the `netlify` folder). Commit.
3. **Netlify:** *Add new project* → *Import an existing project* → GitHub → pick the repository. Leave the build settings empty (no build command; publish directory blank or `.`). Deploy.
4. **Add the environment variables** (Project configuration → Environment variables), then redeploy (Deploys → Trigger deploy):

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | `BCJfvw0IzaLwhdmndLrU7c990sN7wQpncUl1C2e-YwEDNznC0SWWUlq8M5LBUfBUNJ-wVh4LL8m7w6LZ8c8gmlk` |
   | `VAPID_PRIVATE_KEY` | *(the private key you were given in the chat — keep it secret, never commit it)* |
   | `VAPID_SUBJECT` | `mailto:` + your email address |
   | `ANTHROPIC_API_KEY` | *(optional — only for "Scan my meal"; create one at console.anthropic.com. Each scan costs a small amount.)* |

5. **On your phone:** open your Netlify address → *Add to Home Screen* (on iPhone: Share → Add to Home Screen — required for notifications) → open the app **from the new icon**.
6. **Turn on reminders:** Settings → Reminders & Notifications → *Enable notifications* → allow → *Send a test notification*.

## How reminders reach your phone (and how to see what's wrong)

```
You create a reminder -> saved in the app -> app sends the schedule + your time zone to the server
-> server scheduler runs EVERY MINUTE -> at the reminder time it sends a Web Push
-> your phone's push service delivers it -> the app's service worker shows the notification
-> tapping it opens the app (water -> water logging). Nothing is ever logged automatically.
```

No timers in the app deliver anything — that wouldn't work with the app closed. Everything after "saves the schedule" happens on the server and in the browser's push system.

**Settings -> Reminders & Notifications** shows the real state of every step: browser support, permission, service worker, push subscription, backend, server keys, storage, scheduler heartbeat, whether *this device's* reminders are on the server, the last push the server sent, and the last push this device received. Each failure shows its actual reason.

**Test it in this order:**
1. *Enable Notifications* (grant permission). Diagnostics should be all green.
2. *Local display test* - shows a notification through the service worker with no server involved. If this works, your device can display notifications.
3. *Test notification* - the server sends a real push to this device. If this works, keys + backend + push service are all fine.
4. *Start the 1-minute test* - creates a temporary water reminder ~1 minute ahead through the normal pipeline. Lock your phone or switch apps and wait. When you return, the panel tells you which leg worked (server sent it / device received it / displayed it) and removes the temporary reminder.
5. Tap the notification: the app should open to water logging with nothing logged.

**If something is red**, the message says what to do. The common ones:
- *Backend not deployed (404)* - you deployed by drag-and-drop; use GitHub -> Netlify so the `netlify/functions` folder is built.
- *Server keys missing / mismatch* - set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Netlify, then **redeploy**. (`VAPID_SUBJECT` should be `mailto:you@yourmail.com`; a bare email is corrected automatically.)
- *Scheduler has never run* - scheduled functions only run on the **published production deploy** (not deploy previews). Check Netlify -> Logs -> Functions -> `send-reminder`.
- *iPhone: not supported* - the app must be added to the Home Screen and opened from its icon (iOS 16.4+).

## Good to know

- **Your data lives on the device** (in that browser/installed app), not in the cloud. Use *Settings -> Data & Backup -> Export Data* regularly, and *Import Data* to restore or move to a new phone.
- The scheduler checks every minute (Netlify's minimum), in *your* time zone; a reminder arrives within about a minute after its time, never before. It costs roughly 43,000 function runs a month, inside Netlify's free allowance.
- Opening the app re-syncs your schedule to the server, so after changing reminders on a phone, open the app once.
- Update the app by uploading new files to the same GitHub repository; Netlify redeploys automatically.

## What's inside

`index.html` the whole app - `sw.js` offline + push handling - `manifest.json` + icons - `netlify/functions/` the endpoints (`subscribe`, `unsubscribe`, `push-status`, `test-push`, the `send-reminder` scheduler, and the meal-scan proxy) - `netlify/lib/core.mjs` the notification logic - `package.json` dependencies (installed by Netlify).

## Reading the diagnostics (Settings → Reminders & Notifications)

| Row says | What it means | Fix |
|---|---|---|
| Service worker: *sw.js was not found … HTTP 404* | `sw.js` isn't in the deployed site | Put `sw.js` next to `index.html` in the repo root, redeploy |
| Service worker: *returned a web page instead of JavaScript* | A redirect rule serves `index.html` for every path | Remove the catch-all redirect |
| Service worker: *The server refused access … HTTP 401/403* | Site password protection / visitor access is on, so `sw.js` can't be fetched | Netlify → Site configuration → Access & security: turn it off |
| Service worker: *Registration failed: …* | The browser refused it (message shown) | Use the https:// site, not a preview or in-app browser |
| Backend: *Not deployed (HTTP 404)* | The `netlify/functions` folder wasn't deployed | Deploy from GitHub; check Netlify → Functions lists `subscribe`, `push-status`, `test-push`, `send-reminder` |
| *Notifications need to be reconnected.* | Permission is granted but the worker/subscription/server record is missing | Tap **Reconnect Notifications** |
| *Push subscription needs to be renewed.* | The push service said the subscription is dead (410/404); the server removed it | Tap **Reconnect Notifications** |

Quick deploy checks (open in a browser):
- `https://YOUR-SITE/sw.js` → should show JavaScript starting `const VERSION = 'pcos-coach-v7'`
- `https://YOUR-SITE/.netlify/functions/push-status` → should show `{"ok":false,"error":"Method not allowed"}` (that means the backend IS deployed; a 404 means it is not)
