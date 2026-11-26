# Family Video Worker

This is a private server-side worker. It is not part of the browser bundle.

## What it does
- Authenticates provider-credential setup and status requests with the user's Supabase access token.
- Reports only whether the signed-in member has a configured provider; never returns the encrypted key.
- Encrypts each member's own FreeLLMAPI key using AES-256-GCM before storing it.
- Claims queued jobs atomically from Supabase.
- Calls the FreeLLMAPI video endpoint for short clips, normalizes them with FFmpeg, stitches them, optionally generates narration through the OpenAI-compatible `/audio/speech` endpoint, mixes an uploaded music track, and stores the MP4 in the private Supabase Storage bucket.
- Updates job progress and events. Each job uses the provider connection belonging to the member who requested it.
- Maintains a 10-minute database lease while rendering. If the process crashes, an expired job is reclaimed from the beginning, with a maximum of three worker claims.

## Deploy
Deploy this folder as a Docker web service on a host that supports long-running processes and FFmpeg. Set the variables in `.env.example`. Use a persistent worker process; do not deploy as a short-lived serverless function.

The frontend must be configured with `VITE_WORKER_API_URL=https://YOUR_WORKER_HOST`. Configure `APP_ORIGIN` to the exact frontend origin.

## Per-member provider credentials
Every family member must connect their own permitted FreeLLMAPI account / gateway. Do not share the owner's personal FreeLLMAPI key or quota across family members. The gateway base URL must be public HTTPS and end in `/v1`. API keys are never stored in the browser or sent to Supabase directly; they are posted to this worker over HTTPS and encrypted at rest.

## Current rendering behavior
- Uses 6-second generation requests as provider-compatible clip units.
- Assembles longer projects from those clips; provider support, quota and speed determine completion time.
- The final clips are normalized to 1080-sized frames and 30 fps. This is an output target, not a promise of native 1080p source quality.
- Optional AI narration uses `TTS_MODEL` (default `tts-1`) and the selected compatible voice. The gateway must support `/audio/speech`; narration is opt-in and failures explain how to disable it. Uploaded background music is looped/trimmed and mixed at the user-selected volume under narration. Narration and music volumes are saved per job (voice 0–150%, music 0–100%). Recovery restarts an interrupted job from the beginning; it does not resume individual clips.
- If the worker stops unexpectedly, the job is reclaimed after its 10-minute lease expires and restarted from the beginning. A job gets at most three worker claims.
- Provider calls can take up to five minutes per clip. Monitor provider limits before queueing long videos.

## Security
Keep `SUPABASE_SERVICE_ROLE_KEY`, `PROVIDER_CREDENTIALS_ENCRYPTION_KEY`, and provider keys only in server environment variables / encrypted storage. Never add them to `VITE_*` variables, GitHub source, or the PWA.
