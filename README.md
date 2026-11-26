# Family AI Video Studio

A private, family-focused AI video studio designed for mobile-first use.

## Project status

**Phase 2 — authentication foundation added.** The React + TypeScript + Vite PWA now includes a Supabase email/password sign-in and registration gate. Authentication requires the frontend environment variables described below. Family roles, invitations, database policies, AI-provider connections, background rendering, and video downloads are not connected yet.

## Configure Supabase Auth

1. Create or open your Supabase project.
2. In Project Settings → API, copy the Project URL and the Publishable key (or legacy anon public key).
3. In your frontend hosting/build environment, set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. In Supabase Authentication → URL Configuration, add your deployed app URL to Site URL and allowed Redirect URLs.
5. Keep email confirmation enabled for registration until the project owner deliberately changes the policy.

The browser key is a public client key. It is not a substitute for database security. Enable Row Level Security on every user-data table before storing private family data.

## Local development

Requirements: Node.js 20+

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in the two public Supabase values in `.env.local`. Never commit real environment files.

## Security requirements

- Never put Supabase service-role keys or AI provider API keys in browser code or any `VITE_` variable.
- Use Supabase Auth for individual accounts.
- Enforce family membership, roles, and project permissions with database Row Level Security and server-side checks.
- FreeLLMAPI is treated as a single-user/local-first gateway. Do not share one owner's key or proxy one account's generation quota for other family members unless the provider explicitly permits it.
- GitHub Pages can host static frontend files only; it cannot run FFmpeg or long-running rendering jobs.
- Rendering requires a separate server/worker runtime. Free-tier quotas and provider terms must be checked before enabling generation.

## Product goals

- Private family workspace with separate member accounts and owner-managed invitations.
- Text-to-video, image-to-video, story-to-movie, cinematic, animation, educational, promotional, and social-video workflows.
- Cloud generation jobs with progress and a browser-based download flow.
- Target 1080p output where supported; clearly identify native versus upscaled output.
- Support longer projects by generating provider-supported clips and stitching them in a background worker. A single 10-minute generation is not assumed.

## Development sequence

1. PWA shell and responsive workspace UI.
2. Supabase authentication foundation.
3. Family membership, invitations, roles, and Row Level Security.
4. Project/storyboard data model and secure file storage.
5. Server-side AI provider adapters and job queue.
6. Background FFmpeg rendering, progress tracking, and mobile downloads.
7. Security review and end-to-end acceptance tests.
