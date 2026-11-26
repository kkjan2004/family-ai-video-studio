-- Family AI Video Studio: complete Supabase setup
-- Run this entire file once in Supabase Dashboard -> SQL Editor -> New query.
-- It combines migrations 001-005 in their required order.
-- Do not run this if you have already applied any of these migrations; use the individual migrations instead.


-- ============================================================
-- MIGRATION 1: supabase/migrations/202611270001_initial_family_schema.sql
-- ============================================================

-- Family AI Video Studio: initial private-family data model
-- Apply with the Supabase SQL Editor or Supabase CLI.
-- All user-owned records are protected by Row Level Security.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null default 'Untitled project' check (char_length(title) <= 160),
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'queued', 'processing', 'completed', 'failed', 'archived')),
  visibility text not null default 'private'
    check (visibility in ('private', 'family')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists family_members_user_id_idx on public.family_members(user_id);
create index if not exists projects_family_id_created_at_idx on public.projects(family_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.projects enable row level security;

-- SECURITY DEFINER membership check avoids recursive RLS evaluation on family_members.
create or replace function public.is_family_member(target_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.family_members fm
    where fm.family_id = target_family_id
      and fm.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_family_member(uuid) from public;
grant execute on function public.is_family_member(uuid) to authenticated;


-- Profiles: a user can read and edit only their own profile.
drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Families and memberships are visible only to existing members.
drop policy if exists "families_select_members" on public.families;
create policy "families_select_members" on public.families
  for select to authenticated using (
    public.is_family_member(families.id)
  );

drop policy if exists "family_members_select_same_family" on public.family_members;
create policy "family_members_select_same_family" on public.family_members
  for select to authenticated using (
    public.is_family_member(family_members.family_id)
  );

-- Projects are visible only to members of their family.
drop policy if exists "projects_select_family_members" on public.projects;
create policy "projects_select_family_members" on public.projects
  for select to authenticated using (
    public.is_family_member(projects.family_id)
  );

-- Project creation is allowed only for a current family member, and creator must be self.
drop policy if exists "projects_insert_family_members" on public.projects;
create policy "projects_insert_family_members" on public.projects
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and exists (select 1 from public.family_members fm
      where fm.family_id = projects.family_id and fm.user_id = (select auth.uid()))
  );

-- Only creator, owner, or admin may update a project.
drop policy if exists "projects_update_creator_or_admin" on public.projects;
create policy "projects_update_creator_or_admin" on public.projects
  for update to authenticated using (
    exists (select 1 from public.family_members fm
      where fm.family_id = projects.family_id
        and fm.user_id = (select auth.uid())
        and (fm.role in ('owner', 'admin') or projects.created_by = (select auth.uid())))
  ) with check (
    exists (select 1 from public.family_members fm
      where fm.family_id = projects.family_id
        and fm.user_id = (select auth.uid())
        and (fm.role in ('owner', 'admin') or projects.created_by = (select auth.uid())))
  );

drop policy if exists "projects_delete_creator_or_admin" on public.projects;
create policy "projects_delete_creator_or_admin" on public.projects
  for delete to authenticated using (
    exists (select 1 from public.family_members fm
      where fm.family_id = projects.family_id
        and fm.user_id = (select auth.uid())
        and (fm.role in ('owner', 'admin') or projects.created_by = (select auth.uid())))
  );

-- Safely create the first family for the currently signed-in user.
-- The caller automatically becomes the owner; client-supplied user IDs are not accepted.
create or replace function public.create_my_family(family_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_family_id uuid;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You must be signed in to create a family';
  end if;

  if exists (
    select 1 from public.family_members
    where user_id = current_user_id
  ) then
    raise exception 'You already belong to a family workspace';
  end if;

  insert into public.families(name, created_by)
  values (trim(family_name), current_user_id)
  returning id into new_family_id;

  insert into public.family_members(family_id, user_id, role)
  values (new_family_id, current_user_id, 'owner');

  insert into public.profiles(id)
  values (current_user_id)
  on conflict (id) do nothing;

  return new_family_id;
end;
$$;

revoke all on function public.create_my_family(text) from public;
grant execute on function public.create_my_family(text) to authenticated;

-- Keep updated_at current for profiles and projects.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
for each row execute function public.set_updated_at();

-- Intentionally no public signup-to-family auto-join and no client-side membership writes.
-- Invitations and membership administration will be added through audited server-side RPCs.


-- ============================================================
-- MIGRATION 2: supabase/migrations/202611270002_video_pipeline_and_family_invites.sql
-- ============================================================

-- Family AI Video Studio: invitations, project assets, storyboard and render queue.
create extension if not exists pgcrypto;

create table if not exists public.family_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.project_scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sort_order integer not null default 0,
  title text not null default 'Scene',
  narration text,
  visual_prompt text,
  duration_seconds integer not null default 8 check (duration_seconds between 1 and 120),
  style text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id),
  asset_type text not null check (asset_type in ('image','video','audio','subtitle','render')),
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  mode text not null check (mode in ('text_to_video','image_to_video','story_to_movie')),
  prompt text not null,
  target_duration_seconds integer not null default 600 check (target_duration_seconds between 1 and 3600),
  aspect_ratio text not null default '16:9' check (aspect_ratio in ('16:9','9:16','1:1','4:5')),
  quality_target text not null default '1080p' check (quality_target in ('720p','1080p')),
  status text not null default 'queued' check (status in ('queued','planning','generating','rendering','completed','failed','cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  provider text,
  provider_job_id text,
  error_message text,
  output_asset_id uuid references public.project_assets(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.video_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.video_jobs(id) on delete cascade,
  event_type text not null,
  message text not null,
  progress integer check (progress is null or progress between 0 and 100),
  created_at timestamptz not null default now()
);

create unique index if not exists family_members_one_workspace_per_user_idx on public.family_members(user_id);
create index if not exists family_invitations_family_idx on public.family_invitations(family_id, created_at desc);
create index if not exists project_scenes_project_idx on public.project_scenes(project_id, sort_order);
create index if not exists project_assets_project_idx on public.project_assets(project_id, created_at desc);
create index if not exists video_jobs_status_created_idx on public.video_jobs(status, created_at);
create index if not exists video_jobs_project_idx on public.video_jobs(project_id, created_at desc);

alter table public.family_invitations enable row level security;
alter table public.project_scenes enable row level security;
alter table public.project_assets enable row level security;
alter table public.video_jobs enable row level security;
alter table public.video_job_events enable row level security;

-- Shared project visibility: a family member sees shared projects; a creator sees their private projects.
drop policy if exists "projects_select_family_members" on public.projects;
create policy "projects_select_family_members" on public.projects
for select to authenticated using (
  public.is_family_member(family_id)
  and (
    visibility = 'family'
    or created_by = (select auth.uid())
    or exists (
      select 1 from public.family_members fm
      where fm.family_id = projects.family_id
        and fm.user_id = (select auth.uid())
        and fm.role in ('owner','admin')
    )
  )
);

-- Owners/admins can update family settings. Membership itself is only changed by secure RPCs.
drop policy if exists "families_update_admins" on public.families;
create policy "families_update_admins" on public.families
for update to authenticated using (
  exists (select 1 from public.family_members fm
    where fm.family_id = families.id and fm.user_id = (select auth.uid())
      and fm.role in ('owner','admin'))
) with check (
  exists (select 1 from public.family_members fm
    where fm.family_id = families.id and fm.user_id = (select auth.uid())
      and fm.role in ('owner','admin'))
);

drop policy if exists "invitations_select_admins" on public.family_invitations;
create policy "invitations_select_admins" on public.family_invitations
for select to authenticated using (
  exists (select 1 from public.family_members fm
    where fm.family_id = family_invitations.family_id
      and fm.user_id = (select auth.uid()) and fm.role in ('owner','admin'))
);

create or replace function public.create_family_invitation(
  target_family_id uuid, invite_email text, invite_role text, invite_token_hash text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare invitation_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if lower(trim(invite_email)) = '' then raise exception 'Email is required'; end if;
  if invite_role not in ('admin','member') then raise exception 'Invalid invitation role'; end if;
  if length(invite_token_hash) < 40 then raise exception 'Invalid invitation token'; end if;
  if not exists (select 1 from public.family_members fm
    where fm.family_id = target_family_id and fm.user_id = auth.uid()
      and fm.role in ('owner','admin')) then
    raise exception 'Only a family owner or admin can invite members';
  end if;
  insert into public.family_invitations(family_id,email,role,token_hash,invited_by)
  values (target_family_id,lower(trim(invite_email)),invite_role,invite_token_hash,auth.uid())
  returning id into invitation_id;
  return invitation_id;
end;
$$;
revoke all on function public.create_family_invitation(uuid,text,text,text) from public;
grant execute on function public.create_family_invitation(uuid,text,text,text) to authenticated;

create or replace function public.accept_family_invitation(invite_token_hash text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare invitation public.family_invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into invitation from public.family_invitations
  where token_hash = invite_token_hash and accepted_at is null and expires_at > now()
  for update;
  if not found then raise exception 'Invitation is invalid, expired, or already used'; end if;
  if lower(coalesce(auth.jwt() ->> 'email','')) <> invitation.email then
    raise exception 'Sign in with the email address that received this invitation';
  end if;
  if exists (select 1 from public.family_members fm where fm.user_id = auth.uid()) then
    raise exception 'This account already belongs to a family workspace';
  end if;
  insert into public.family_members(family_id,user_id,role)
  values (invitation.family_id,auth.uid(),invitation.role);
  update public.family_invitations set accepted_at = now() where id = invitation.id;
  insert into public.profiles(id) values (auth.uid()) on conflict (id) do nothing;
  return invitation.family_id;
end;
$$;
revoke all on function public.accept_family_invitation(text) from public;
grant execute on function public.accept_family_invitation(text) to authenticated;

-- A project is accessible only when the caller can see its parent project.
create or replace function public.can_access_project(target_project_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id
      and public.is_family_member(p.family_id)
      and (p.visibility = 'family' or p.created_by = auth.uid()
        or exists (select 1 from public.family_members fm
          where fm.family_id = p.family_id and fm.user_id = auth.uid()
            and fm.role in ('owner','admin')))
  );
$$;
revoke all on function public.can_access_project(uuid) from public;
grant execute on function public.can_access_project(uuid) to authenticated;

drop policy if exists "scenes_select_project_access" on public.project_scenes;
create policy "scenes_select_project_access" on public.project_scenes
for select to authenticated using (public.can_access_project(project_id));
drop policy if exists "scenes_insert_project_access" on public.project_scenes;
create policy "scenes_insert_project_access" on public.project_scenes
for insert to authenticated with check (public.can_access_project(project_id));
drop policy if exists "scenes_update_project_access" on public.project_scenes;
create policy "scenes_update_project_access" on public.project_scenes
for update to authenticated using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "scenes_delete_project_access" on public.project_scenes;
create policy "scenes_delete_project_access" on public.project_scenes
for delete to authenticated using (public.can_access_project(project_id));

drop policy if exists "assets_select_project_access" on public.project_assets;
create policy "assets_select_project_access" on public.project_assets
for select to authenticated using (public.can_access_project(project_id));
drop policy if exists "assets_insert_project_access" on public.project_assets;
create policy "assets_insert_project_access" on public.project_assets
for insert to authenticated with check (
  uploaded_by = (select auth.uid()) and public.can_access_project(project_id)
);

drop policy if exists "jobs_select_project_access" on public.video_jobs;
create policy "jobs_select_project_access" on public.video_jobs
for select to authenticated using (public.can_access_project(project_id));
drop policy if exists "jobs_insert_own_project" on public.video_jobs;
create policy "jobs_insert_own_project" on public.video_jobs
for insert to authenticated with check (
  requested_by = (select auth.uid()) and public.can_access_project(project_id)
);
-- Browser clients cannot alter job status/progress. A trusted worker using service role does that.
drop policy if exists "job_events_select_project_access" on public.video_job_events;
create policy "job_events_select_project_access" on public.video_job_events
for select to authenticated using (
  exists (select 1 from public.video_jobs j
    where j.id = video_job_events.job_id and public.can_access_project(j.project_id))
);

drop trigger if exists scenes_set_updated_at on public.project_scenes;
create trigger scenes_set_updated_at before update on public.project_scenes
for each row execute function public.set_updated_at();

-- Verify that a storage path's family and project IDs match the same database row.
create or replace function public.can_access_family_project_path(target_family_id uuid, target_project_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id and p.family_id = target_family_id
      and public.can_access_project(p.id)
  );
$$;
revoke all on function public.can_access_family_project_path(uuid,uuid) from public;
grant execute on function public.can_access_family_project_path(uuid,uuid) to authenticated;

-- Private object bucket. Paths must start with family_id/project_id.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('family-projects','family-projects',false,52428800,
  array['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav','audio/ogg','text/vtt'])
on conflict (id) do update set public=false, file_size_limit=52428800,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav','audio/ogg','text/vtt'];

drop policy if exists "family_storage_read_project_members" on storage.objects;
create policy "family_storage_read_project_members" on storage.objects
for select to authenticated using (
  bucket_id = 'family-projects'
  and (storage.foldername(name))[1] is not null
  and public.can_access_family_project_path(((storage.foldername(name))[1])::uuid, ((storage.foldername(name))[2])::uuid)
);
drop policy if exists "family_storage_upload_project_members" on storage.objects;
create policy "family_storage_upload_project_members" on storage.objects
for insert to authenticated with check (
  bucket_id = 'family-projects'
  and owner_id = (select auth.uid())::text
  and public.can_access_family_project_path(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);
drop policy if exists "family_storage_delete_owner_or_uploader" on storage.objects;
create policy "family_storage_delete_owner_or_uploader" on storage.objects
for delete to authenticated using (
  bucket_id = 'family-projects'
  and owner_id = (select auth.uid())::text
);

-- This schema intentionally queues jobs but does not fake AI rendering.
-- A trusted server worker must claim jobs, call authorized providers, stitch clips with FFmpeg,
-- and update progress/output using server-only credentials.

-- Each member connects their own permitted provider account. Secrets are encrypted by the trusted worker.
create table if not exists public.provider_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('freellmapi')),
  base_url text not null,
  model text not null default 'auto',
  encrypted_api_key text not null,
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.provider_connections enable row level security;
-- No browser policies: only the trusted worker's service-role connection may read/write credentials.

-- Atomically claim one queued job so multiple worker instances do not process the same job.
create or replace function public.claim_next_video_job()
returns setof public.video_jobs
language sql
security definer
set search_path = ''
as $$
  update public.video_jobs
  set status = 'planning', progress = 1, started_at = now(), error_message = null
  where id = (
    select id from public.video_jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;
revoke all on function public.claim_next_video_job() from public, anon, authenticated;
grant execute on function public.claim_next_video_job() to service_role;


-- ============================================================
-- MIGRATION 3: supabase/migrations/202611270003_video_job_recovery.sql
-- ============================================================

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


-- ============================================================
-- MIGRATION 4: supabase/migrations/202611270004_audio_production.sql
-- ============================================================

-- Optional audio production settings for each queued video job.
alter table public.video_jobs
  add column if not exists narration_enabled boolean not null default false,
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


-- ============================================================
-- MIGRATION 5: supabase/migrations/202611270005_audio_mix_levels.sql
-- ============================================================

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
