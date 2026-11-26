# Family AI Video Studio

A private, mobile-first AI video studio for one family workspace with separate member accounts.

## Current implementation

- React + TypeScript + Vite installable PWA.
- Supabase email/password authentication.
- Private family workspace creation, member roles and email-bound invitation links.
- Family-shared and creator-private projects with database Row Level Security.
- Storyboard, media asset and video job database structures.
- Private Supabase Storage bucket for project media and rendered MP4 files.
- Per-member FreeLLMAPI connection setup. Provider keys are encrypted by the trusted worker and are not exposed to the browser or other family members.
- Node.js + FFmpeg worker that claims jobs, requests short MP4 clips, normalizes them and stitches a final MP4 with optional AI narration and uploaded background music.
- Signed browser download links for completed videos.

A successful frontend build does not mean the cloud services are already configured. Apply all five SQL migrations and deploy the worker before generation can run.

## One-page deployment runbook

For the complete end-to-end setup in one place, follow [`DEPLOYMENT_BULK_CHECKLIST.md`](./DEPLOYMENT_BULK_CHECKLIST.md). It covers Supabase, Vercel, the Docker worker, environment variables and final live tests.

## 1. Supabase setup

1. Create a Supabase project (Mumbai region is preferred for an India-based workspace, if available).
2. In **Project Settings → API**, copy the Project URL and Publishable key (or legacy anon public key).
3. Set the frontend build variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_WORKER_API_URL` (after the worker is deployed)
4. In **Authentication → URL Configuration**, add the exact deployed PWA URL to Site URL and Redirect URLs.
5. Keep email confirmation enabled for new accounts.

### Apply database migrations

**Mobile-friendly one-file option:** open [`supabase/SETUP_ALL.sql`](supabase/SETUP_ALL.sql), copy the entire file, paste it into Supabase **SQL Editor → New query**, and run it once. This combines migrations 001–005 in order. Do not run the combined script if you have already applied any of those migrations; in that case, continue only with the unapplied individual files below.

Or run these files individually in order in Supabase **SQL Editor**:

1. `supabase/migrations/202611270001_initial_family_schema.sql`
2. `supabase/migrations/202611270002_video_pipeline_and_family_invites.sql`
3. `supabase/migrations/202611270003_video_job_recovery.sql`
4. `supabase/migrations/202611270004_audio_production.sql`
5. `supabase/migrations/202611270005_audio_mix_levels.sql`

They create the family workspace, RLS policies, invitation functions, project scenes/assets, job queue, encrypted provider-connection table, atomic worker claim function, private Storage bucket, automatic recovery leases for interrupted video jobs, and optional narration / background music settings. Narration prompts prioritize natural human-like delivery.

## 2. Deploy the frontend PWA

The repository includes `vercel.json` for a Vite single-page app. Import the private GitHub repository into Vercel and set these build environment variables before deploying:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_WORKER_API_URL` (after the worker is deployed)

Redeploy after changing environment variables. Then add the Vercel deployment URL to Supabase Authentication → URL Configuration and set it as the Site URL.

The worker also provides an authenticated provider-connection status endpoint; the app checks it when Settings opens and never reads or displays stored API keys. Job polling uses a stable 10-second timer while work is active.

## 3. Deploy the rendering worker

Deploy the `worker/` folder as a Docker web service on a host that supports a long-running process and FFmpeg. GitHub Pages and Supabase Edge Functions are not suitable for the long-running FFmpeg worker.

Set the worker environment variables from `worker/.env.example`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server only; never put this in the frontend.
- `PROVIDER_CREDENTIALS_ENCRYPTION_KEY` — 64 hex characters (32 random bytes).
- `APP_ORIGIN` — exact frontend origin, including https.
- Optional `PORT` and `POLL_INTERVAL_MS`.

Generate a 32-byte encryption key using a trusted password manager or secure random generator. Keep a backup: changing it makes previously encrypted provider credentials unreadable.

After deployment, set frontend build variable `VITE_WORKER_API_URL` to the worker's HTTPS origin.

## 4. Connect each member's own video gateway

In Studio → Settings, each member can connect their own permitted FreeLLMAPI gateway:

- Base URL must be public HTTPS and end in `/v1`.
- The key is posted to the worker over HTTPS and encrypted using AES-256-GCM before storage.
- The worker uses only the key belonging to the member who submitted that job.
- Do not share one owner's personal FreeLLMAPI key, account or quota with other family members unless the provider explicitly allows it.
- The worker calls `POST /v1/videos/generations`; provider/model duration and aspect-ratio support can vary.

## 5. Local frontend development

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill only the public frontend values in `.env.local`. Never commit real environment files.

## Product behavior and limits

- Text-to-video, image-to-video and story-to-movie jobs are saved to the private queue.
- The worker currently generates 6-second clips, normalizes them with FFmpeg, and stitches them into MP4.
- Longer videos require many provider requests; completion time and availability depend on each member's provider quota and provider support.
- The worker targets 1080-sized frames, but this does not guarantee native 1080p source quality.
- Optional AI narration and uploaded background music are supported. Narration is generated scene-by-scene through the member's compatible `/audio/speech` gateway, then mixed with music using FFmpeg. Voice and music levels are configurable. Natural-delivery instructions are sent where supported; providers that reject optional prosody fields receive one portable-format retry. When the gateway reports its routed speech model, later scenes are pinned to that model where supported. Actual voice quality, Telugu pronunciation and voice consistency still require a real provider audio test. If a worker process stops unexpectedly, a 10-minute lease expires and the job is automatically retried from the beginning, up to three worker claims.
- The private Supabase Storage bucket is set to 50 MB per object to fit the current Free-plan global file limit. Long 1080p videos may exceed this cap; the worker compresses output and rejects files above 50 MB. Larger files require a higher Supabase plan or a separate object-storage service.

## Security

- Never place Supabase service-role keys, encryption keys or AI provider API keys in browser code, GitHub source or any `VITE_*` variable.
- User data tables use Row Level Security; invitations are bound to the invited email and expire after seven days.
- Provider credentials are stored only in the server-side table and encrypted by the worker.
- Private media is stored in a non-public bucket and downloaded using short-lived signed URLs.
- Review provider terms and quotas before enabling generation for family members.

## CI

GitHub Actions runs the TypeScript/Vite production build, checks worker JavaScript syntax, installs worker dependencies, and builds the FFmpeg worker Docker image without publishing it. A passing CI run validates code/build checks only; it does not apply Supabase migrations, deploy the PWA or worker, or prove a live provider TTS/video request.
