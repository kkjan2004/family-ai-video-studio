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
  if exists (select 1 from public.family_members fm
    where fm.family_id = invitation.family_id and fm.user_id = auth.uid()) then
    raise exception 'You are already a member of this family';
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
as $
  select exists (
    select 1 from public.projects p
    where p.id = target_project_id and p.family_id = target_family_id
      and public.can_access_project(p.id)
  );
$;
revoke all on function public.can_access_family_project_path(uuid,uuid) from public;
grant execute on function public.can_access_family_project_path(uuid,uuid) to authenticated;

-- Private object bucket. Paths must start with family_id/project_id.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('family-projects','family-projects',false,524288000,
  array['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/wav','text/vtt'])
on conflict (id) do update set public=false;

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
  and public.can_access_project(((storage.foldername(name))[2])::uuid)
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
