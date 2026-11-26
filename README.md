# Family AI Video Studio

A private, family-focused AI video studio designed for mobile-first use.

## Project status

**Phase 1 — frontend foundation.** This repository currently contains the installable PWA shell and responsive UI foundation. Authentication, database policies, AI-provider connections, background rendering, and video downloads are not connected yet.

## Product goals

- Private family workspace with separate member accounts and owner-managed invitations.
- Text-to-video, image-to-video, story-to-movie, cinematic, animation, educational, promotional, and social-video workflows.
- Mobile-first installable PWA with an English interface.
- Cloud generation jobs with progress and a browser-based download flow.
- Target 1080p output where supported; clearly identify native versus upscaled output.
- Support longer projects by generating provider-supported clips and stitching them in a background worker. A single 10-minute generation is not assumed.

## Security and provider constraints

- Never place provider API keys in browser code or client-visible environment variables.
- Keep secrets in server-side secret storage only.
- Supabase Auth, Postgres, and Row Level Security will enforce family membership and project permissions.
- FreeLLMAPI is treated as a single-user/local-first gateway. Do not share one owner's key or proxy one account's generation quota for other family members unless the provider explicitly permits it.
- GitHub Pages can host static frontend files only; it cannot run FFmpeg or long-running rendering jobs.
- Rendering requires a separate server/worker runtime. Free-tier quotas and provider terms must be checked before enabling generation.

## Planned architecture

- Frontend: React + TypeScript + Vite + PWA.
- Identity/data: Supabase Auth + Postgres + Row Level Security.
- AI gateway: server-side adapter for authorized providers.
- Rendering: queued background worker with FFmpeg clip stitching.
- Storage: private object storage with signed, permission-checked downloads.

## Local development

Requirements: Node.js 20+

```bash
npm install
npm run dev
```

## Environment variables

Do not add real secrets to Git. A future backend will use server-side environment variables. The frontend must never receive provider API keys.

## Development sequence

1. PWA shell and responsive workspace UI.
2. Supabase authentication, family invitations, roles, and RLS.
3. Project/storyboard data model and secure file storage.
4. Server-side AI provider adapters and job queue.
5. Background FFmpeg rendering, progress tracking, and mobile downloads.
6. Security review and end-to-end acceptance tests.
