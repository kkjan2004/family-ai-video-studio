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
