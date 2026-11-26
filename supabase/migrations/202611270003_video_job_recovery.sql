-- Recover video jobs safely if a worker process stops unexpectedly.
alter table public.video_jobs
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table public.video_jobs
  drop constraint if exists video_jobs_attempt_count_check;
alter table public.video_jobs
  add constraint video_jobs_attempt_count_check check (attempt_count between 0 and 3);

-- Give already-running jobs a lease so a deployment during migration cannot strand them.
update public.video_jobs
set lease_expires_at = coalesce(started_at, created_at) + interval '10 minutes'
where status in ('planning','generating','rendering')
  and lease_expires_at is null;

create or replace function public.claim_next_video_job()
returns setof public.video_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.video_jobs%rowtype;
begin
  update public.video_jobs
  set status = 'failed',
      error_message = 'Worker lease expired after three attempts. Please submit the job again.',
      completed_at = now(),
      lease_expires_at = null
  where status in ('planning','generating','rendering')
    and lease_expires_at < now()
    and attempt_count >= 3;

  select * into claimed
  from public.video_jobs
  where status = 'queued'
     or (
       status in ('planning','generating','rendering')
       and lease_expires_at < now()
       and attempt_count < 3
     )
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.video_jobs
  set status = 'planning',
      progress = 1,
      started_at = now(),
      error_message = null,
      attempt_count = attempt_count + 1,
      lease_expires_at = now() + interval '10 minutes'
  where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$$;

revoke all on function public.claim_next_video_job() from public, anon, authenticated;
grant execute on function public.claim_next_video_job() to service_role;
