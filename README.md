# Bunker Siege — Online Co-op

This project includes the browser game and a Node.js WebSocket server for public co-op rooms (up to 4 players per room).

## Run locally

1. Install Node.js 18 or newer from https://nodejs.org/.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Open http://localhost:3000 in two browser tabs. In one tab choose **Co-op → Create room**; in the other choose **Co-op → Join**.

## Deploy online for free with Render

You must use your own GitHub and Render accounts to publish this project; I cannot sign in or create the public service on your behalf from this chat.

1. Create a repository at https://github.com/new.
2. Upload the contents of this folder to the repository root. Keep `public/` and its files in place. Do not upload `node_modules`.
3. Open https://render.com/ and sign in with GitHub.
4. Choose **New → Blueprint** and select the repository (or choose **New → Web Service** and use the settings below).
5. The included `render.yaml` configures a free Node web service. Review it and deploy.
6. After deployment, open the `onrender.com` URL Render displays. Click **Co-op → Create room**. Share that same URL with friends; they can click **Co-op → Join** to see and join open rooms.

### Manual Render settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Instance type: Free

## Free-tier limitations

- The service may sleep after inactivity; the first visitor after sleep may wait for it to start.
- Restarts or redeploys clear open rooms and disconnect players.
- The game is a casual co-op prototype: the host player's browser runs the wave/bot simulation. It is not cheat-proof and does not include accounts or text chat.

## Files

- `server.js` — HTTP server, WebSocket connection, public room list and state relay.
- `public/index.html` — game UI and gameplay.
- `public/three.min.js` — bundled Three.js dependency.
- `render.yaml` — Render deployment blueprint.
- `package.json` / `package-lock.json` — Node dependencies and start command.
