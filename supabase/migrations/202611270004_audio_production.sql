-- Optional audio production settings for each queued video job.
alter table public.video_jobs
  add column if not exists narration_enabled boolean not null default true,
  add column if not exists narration_voice text not null default 'alloy',
  add column if not exists background_music_path text;

alter table public.video_jobs
  drop constraint if exists video_jobs_narration_voice_check;
alter table public.video_jobs
  add constraint video_jobs_narration_voice_check
  check (narration_voice in ('alloy','nova','echo','onyx','shimmer'));

alter table public.video_jobs
  drop constraint if exists video_jobs_background_music_path_check;
alter table public.video_jobs
  add constraint video_jobs_background_music_path_check
  check (background_music_path is null or length(background_music_path) <= 1024);
