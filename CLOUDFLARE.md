# Deploy Kage to Cloudflare for free

The migration is prepared locally. Nothing has been published to Cloudflare.

This uses **Cloudflare Workers with Static Assets** to host both the website and
its API at one `workers.dev` address. It does not require Pages, a purchased
domain, R2, a Cloudflare database, or a paid Workers subscription. Existing Groq
and Firebase accounts continue to supply AI and saved data within their own quotas.

## Publish from this Mac

Use **Node.js 22 or newer**. This Mac's default Node is currently 21; the Node 24
runtime bundled with Codex is available for this terminal session:

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
cd /Users/ray/shadowing
npm ci
npx wrangler login
npm run deploy:cloudflare
npm run secrets:cloudflare
```

If that bundled runtime is no longer installed, use your own Node 22+ installation.
`wrangler login` opens Cloudflare authorization in your browser. Choose your
account and stay on the **Workers Free** plan. The deploy command prints your
actual website URL; use that URL rather than a guessed hostname.

The first deployment publishes the site and its audio. The final command reads
the existing `.env` and uploads only these four values as encrypted Worker secrets:

- `GROQ_API_KEY`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

It sends values directly to Wrangler through stdin; it does not print them or
create a secrets export file. Preview the **names only**, without uploading:

```sh
node scripts/cloudflare-secrets.mjs --dry-run
```

After the secrets upload completes, refresh the site. The status indicator should
say **AI ready**. Load a lesson and confirm the saved clips and mastered progress.
The first visit uses a new browser origin, so browser-only preferences and
recordings remain on the old Render origin; Firebase-backed progress and prepared
transcripts stay available. Export any browser-only recordings you want to keep
before deleting the old Render site.

## Later updates

```sh
npm run deploy:cloudflare
```

Secrets persist across deployments. Repeat `npm run secrets:cloudflare` only when
you change a key. The existing GitHub Pages workflow does not deploy to Cloudflare;
these commands deploy directly from the local checkout.

## Test locally

```sh
npm run test:cloudflare
npm run dev:cloudflare
```

The local preview reads `.env` automatically. Local AI requests use Groq and local
progress saves use the same Firebase database as the live site. `npm start` still
runs the original Node server.

## Audio and free-plan limits

The build preserves every audio byte and packages tracks into assets of at most
4 MiB, safely below Cloudflare's 25 MiB per-asset ceiling. The Worker streams them
back under the original audio URLs and supports byte ranges for seeking. Source
audio files and prepared timestamps stay unchanged. Only the generated public
bundle is uploaded; `.env`, private keys, source code, and local recordings are
not public assets.

Audio playback and API requests invoke the Worker and share its free request and
CPU limits. Ordinary static pages, styles, and scripts use static asset serving.
Free does not mean unlimited: the documented Workers Free request allowance is
100,000 per day, with 10 ms CPU time per invocation. Production traffic and cold
requests must remain within these limits. Local validation cannot certify live
CPU usage, so check the Cloudflare dashboard after publishing. No paid resource
or automatic paid upgrade is configured by this project.

Official references: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[platform limits](https://developers.cloudflare.com/workers/platform/limits/),
[static asset configuration](https://developers.cloudflare.com/workers/static-assets/binding/),
and [Wrangler deployment](https://developers.cloudflare.com/workers/get-started/guide/).
