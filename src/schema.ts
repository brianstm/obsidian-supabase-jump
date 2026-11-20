export const DB_TABLE = "vault_files";
export const VERSIONS_TABLE = "vault_file_versions";
export const STORAGE_BUCKET = "vault-attachments";
export const SCHEMA_VERSION = 2;

export const SETUP_SQL = `
-- Files table
create table if not exists public.vault_files (
  id           text primary key,
  vault_id     text not null,
  path         text not null,
  content      text,
  storage_path text,
  is_binary    boolean default false,
  frontmatter  jsonb,
  tags         text[],
  mtime        bigint not null,
  ctime        bigint not null,
  size         bigint not null,
  deleted      boolean default false,
  updated_at   timestamptz default now(),
  user_id      uuid references auth.users(id),
  platform     text default 'all',
  device_id    text,
  device_name  text
);
alter table public.vault_files add column if not exists frontmatter jsonb;
alter table public.vault_files add column if not exists tags text[];
alter table public.vault_files add column if not exists platform text default 'all';
alter table public.vault_files add column if not exists device_id text;
alter table public.vault_files add column if not exists device_name text;
create index if not exists vault_files_vault_path on public.vault_files(vault_id, path);
create index if not exists vault_files_vault_mtime on public.vault_files(vault_id, mtime);
create index if not exists vault_files_vault_updated on public.vault_files(vault_id, updated_at);
create index if not exists vault_files_tags on public.vault_files using gin(tags);
alter table public.vault_files enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'vault_files' and policyname = 'Users manage own vault'
  ) then
    create policy "Users manage own vault" on public.vault_files for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'vault_files'
  ) then
    alter publication supabase_realtime add table public.vault_files;
  end if;
end $$;

-- Version history
create table if not exists public.vault_file_versions (
  id          bigserial primary key,
  file_id     text not null,
  vault_id    text not null,
  path        text not null,
  content     text,
  size        bigint,
  device_name text,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists vault_file_versions_file
  on public.vault_file_versions(file_id, created_at desc);
alter table public.vault_file_versions enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'vault_file_versions' and policyname = 'Users manage own versions'
  ) then
    create policy "Users manage own versions" on public.vault_file_versions for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Server timestamps and automatic snapshots (at most one every 10 minutes, last 50 kept)
create or replace function public.vault_files_before_write() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE'
     and coalesce(old.is_binary, false) = false
     and old.content is not null
     and old.content is distinct from new.content
     and old.user_id = auth.uid() then
    if not exists (
      select 1 from public.vault_file_versions
      where file_id = old.id and created_at > now() - interval '10 minutes'
    ) then
      insert into public.vault_file_versions (file_id, vault_id, path, content, size, device_name, user_id)
      values (old.id, old.vault_id, old.path, old.content, old.size, old.device_name, old.user_id);
      delete from public.vault_file_versions
      where file_id = old.id and id not in (
        select id from public.vault_file_versions
        where file_id = old.id order by created_at desc limit 50
      );
    end if;
  end if;
  return new;
end $$;
drop trigger if exists vault_files_before_write on public.vault_files;
create trigger vault_files_before_write
  before insert or update on public.vault_files
  for each row execute function public.vault_files_before_write();

-- Attachments bucket
insert into storage.buckets (id, name, public)
values ('vault-attachments', 'vault-attachments', false)
on conflict (id) do nothing;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users manage own attachments'
  ) then
    create policy "Users manage own attachments" on storage.objects for all
      using (auth.uid()::text = (storage.foldername(name))[1])
      with check (auth.uid()::text = (storage.foldername(name))[1]);
  end if;
end $$;

-- Private live editing channels
do $$ begin
  if to_regclass('realtime.messages') is not null then
    if not exists (
      select 1 from pg_policies
      where schemaname = 'realtime' and tablename = 'messages'
        and policyname = 'Users read own live channels'
    ) then
      create policy "Users read own live channels" on realtime.messages
        for select to authenticated
        using (realtime.topic() like 'sbj:' || auth.uid()::text || ':%');
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'realtime' and tablename = 'messages'
        and policyname = 'Users write own live channels'
    ) then
      create policy "Users write own live channels" on realtime.messages
        for insert to authenticated
        with check (realtime.topic() like 'sbj:' || auth.uid()::text || ':%');
    end if;
  end if;
end $$;
`.trim();
