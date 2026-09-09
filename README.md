# StudentMap

Real-time campus map showing the live, exact GPS positions of everyone
currently connected — anonymously, as coloured dots by role (student,
faculty, staff). No names, no IDs, no manual location picking.

## Architecture

| Piece | Tech | Hosted on |
|---|---|---|
| Frontend | React 19 + Vite + Leaflet | Netlify (static) |
| Backend | FastAPI + WebSockets | Render (persistent server) |

**Why two hosts?** The app's core is a persistent WebSocket connection that
keeps every connected user's position in memory and broadcasts updates to
everyone. Netlify only serves static files and short-lived serverless
functions, which cannot hold a WebSocket open — so the API lives on Render,
which can.

```
Browser ──── HTTPS ────► Netlify (React bundle)
   │
   └──────── WSS ───────► Render (FastAPI, live locations)
```

## Local development

Two terminals:

```bash
# 1. Backend  → http://localhost:8000
pip install -r requirements.txt
python main.py

# 2. Frontend → http://localhost:5173
cd frontend
npm install
npm run dev
```

Vite proxies `/api` and `/ws` to `localhost:8000`, so no environment
variables or CORS setup are needed locally.

Note that browsers only allow GPS on a secure origin. `localhost` counts as
secure, but a phone hitting your laptop's LAN IP over plain HTTP does not —
that's what the built-in Pinggy tunnel is for. It starts automatically and
prints a public HTTPS URL; the "Share Link" button shows it as a QR code.
Set `ENABLE_TUNNEL=0` to skip it.

## Deploying

### 1. Backend → Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → **New** → **Blueprint**, point it at
   the repo. It reads `render.yaml` and creates the service.
3. Wait for the deploy, then note the URL, e.g.
   `https://studentmap-api.onrender.com`.
4. Check it: visiting `/api/status` should return
   `{"active_users":0,"status":"running"}`.

Render's free tier sleeps after ~15 minutes of no traffic, so the first
request after an idle period takes ~50s to wake the server.

### 2. Frontend → Netlify

1. On [netlify.com](https://netlify.com) → **Add new site** → **Import an
   existing project**, choose the same repo. `netlify.toml` supplies the build
   settings (base `frontend`, build `npm run build`, publish `dist`).
2. Before the first deploy, add an environment variable:

   | Key | Value |
   |---|---|
   | `VITE_BACKEND_URL` | `https://studentmap-api.onrender.com` |

   This is baked in at build time, so **redeploy after changing it**.
3. Deploy. Open the Netlify URL on a phone and allow location access.

### 3. Lock down CORS (optional but recommended)

Once you know the Netlify URL, set `CORS_ORIGINS` on the Render service to it
(e.g. `https://studentmap-uiu.netlify.app`) instead of the default `*`.

## Environment variables

**Backend**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Port to bind. Render sets this automatically. |
| `ENABLE_TUNNEL` | `1` | `0` disables the local dev tunnel. Off in production. |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins for `/api/*` calls. |

**Frontend**

| Variable | Default | Purpose |
|---|---|---|
| `VITE_BACKEND_URL` | *(unset)* | Backend base URL. Unset = same origin (local dev proxy). |

## Privacy note

The server stores only an anonymous random ID, a role, and coordinates — no
names or identifiers. Locations are shared with everyone connected, and the
deployed URL is public, so anyone with the link can see the map. Treat the
link as the access control it is.

Location integrity is only enforced in the UI: there is no way to set your
own position by hand in the app, but a technically capable user could still
send fabricated coordinates over the WebSocket directly. Cryptographically
proving a browser's GPS is genuine isn't possible from a web app.
