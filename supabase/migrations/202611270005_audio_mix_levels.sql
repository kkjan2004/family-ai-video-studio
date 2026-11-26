-- Per-job audio mix levels, bounded to safe FFmpeg volume ranges.
alter table public.video_jobs
  add column if not exists narration_volume numeric not null default 1.0,
  add column if not exists music_volume numeric not null default 0.18;

alter table public.video_jobs
  drop constraint if exists video_jobs_narration_volume_check;
alter table public.video_jobs
  add constraint video_jobs_narration_volume_check
  check (narration_volume between 0 and 1.5);

alter table public.video_jobs
  drop constraint if exists video_jobs_music_volume_check;
alter table public.video_jobs
  add constraint video_jobs_music_volume_check
  check (music_volume between 0 and 1);
