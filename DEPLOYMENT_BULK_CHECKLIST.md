# Family AI Video Studio — bulk deployment checklist

This is the single deployment runbook for the private family studio. Complete the Supabase database setup first; the PWA and worker cannot run correctly without it.

## A. Supabase database (one-time)

1. Open the Supabase project selected for this app.
2. Open **SQL Editor → New query**.
3. Copy the complete contents of [SETUP_ALL.sql](./SETUP_ALL.sql), paste it into the editor, and run once.
4. Confirm the SQL Editor reports success. If any of migrations 001–005 were already run, do not run the combined script; apply only missing migrations in order.

## B. Collect the three Supabase values

From **Project Settings → API**, copy:
- Project URL
- Publishable key (or legacy anon public key)
- Secret/service-role key (server only)

The publishable/anon key is used in the frontend. The service-role key is used only by the worker's private environment. Never paste the service-role key into GitHub source, the PWA, or any `VITE_*` variable.

## C. Deploy the frontend (Vercel)

Import GitHub repository `kkjan2004/family-ai-video-studio` into Vercel. Framework/build/output are already configured in `vercel.json`.

Set build environment variables:
- `VITE_SUPABASE_URL` = Supabase Project URL
- `VITE_SUPABASE_ANON_KEY` = Supabase Publishable/anon key
- `VITE_WORKER_API_URL` = worker HTTPS URL from section D (add after worker is deployed)

Deploy, then copy the final HTTPS frontend URL.

## D. Deploy the worker (Docker host with FFmpeg)

Create a Docker web service from the same GitHub repository:
- Dockerfile path: `worker/Dockerfile`
- Docker build context: repository root
- Health check path: `/health`
- Port: `8080` (or use the host-provided PORT)

Set these private environment variables on the worker host:
- `SUPABASE_URL` = same Supabase Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = Supabase service-role/secret key
- `PROVIDER_CREDENTIALS_ENCRYPTION_KEY` = exactly 64 hexadecimal characters (32 random bytes)
- `APP_ORIGIN` = exact Vercel frontend origin, e.g. `https://your-app.vercel.app`
- `TTS_MODEL` = `auto`
- `POLL_INTERVAL_MS` = `5000`

Generate the encryption key with a trusted password manager's 32-byte random generator. Back it up securely. Do not change it after members save provider keys; changing it makes already stored encrypted provider keys unreadable.

Deploy the worker and verify its public HTTPS `/health` endpoint returns JSON with `ok: true`.

## E. Finish the frontend connection

In Vercel, set `VITE_WORKER_API_URL` to the worker's HTTPS origin and redeploy the frontend.

In Supabase **Authentication → URL Configuration**, set the deployed frontend URL as Site URL and add it to Redirect URLs.

## F. Live acceptance test

1. Open the PWA and create the family owner account; confirm the email if Supabase email confirmation is enabled.
2. Sign in and create the family workspace.
3. Open Settings and confirm the worker reports **Online**.
4. Connect that member's own permitted FreeLLMAPI HTTPS gateway ending in `/v1`, with that member's own key.
5. Run a short test video first (not 10 minutes). Test Telugu narration separately with a short Telugu script and listen for pronunciation, naturalness and consistent voice. Provider support and actual audio quality vary.
6. Confirm the finished MP4 plays, audio is mixed as selected, and the project is visible only to its intended creator/family members.

## Important limits

- GitHub Actions passing means build/syntax checks passed; it does not mean Supabase, Vercel, the worker, or a provider has been connected.
- Supabase Free Storage currently limits each object to 50 MB; longer/higher-quality outputs may need a paid plan or external object storage.
- A 10-minute output is assembled from multiple short provider clips; it is not one-shot generation. Provider quotas, model support, render host limits and cost apply.
- A 1080p output target does not guarantee native 1080p source quality.
- Human-like voice is a quality target, not a guarantee. Verify the selected provider's Telugu TTS output before relying on it.
