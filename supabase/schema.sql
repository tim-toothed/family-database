create schema if not exists family_site;

create table if not exists family_site.family_yaml (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint family_yaml_payload_is_object check (jsonb_typeof(payload) = 'object')
);

create table if not exists family_site.family_people (
  id text primary key references family_site.family_yaml(id) on delete cascade,
  display_name text not null
);

create or replace function family_site.family_compute_display_name(person_payload jsonb, fallback_id text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      btrim(
        case
          when jsonb_typeof(person_payload -> 'birth_name') = 'string'
            then person_payload ->> 'birth_name'
          when jsonb_typeof(person_payload -> 'birth_name') = 'object'
            then concat_ws(
              ' ',
              nullif(btrim(person_payload #>> '{birth_name,surname}'), ''),
              nullif(btrim(person_payload #>> '{birth_name,first_name}'), ''),
              nullif(btrim(person_payload #>> '{birth_name,patronymic}'), '')
            )
          else ''
        end
      ),
      ''
    ),
    nullif(btrim(fallback_id), ''),
    '???'
  );
$$;

create or replace function family_site.family_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  if tg_op = 'INSERT' and new.created_at is null then
    new.created_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create or replace function family_site.family_sync_people()
returns trigger
language plpgsql
security definer
set search_path = family_site, public
as $$
begin
  insert into family_site.family_people (id, display_name)
  values (new.id, family_site.family_compute_display_name(new.payload, new.id))
  on conflict (id) do update
    set display_name = excluded.display_name;

  return new;
end;
$$;

drop trigger if exists family_yaml_touch_updated_at on family_site.family_yaml;
create trigger family_yaml_touch_updated_at
before insert or update on family_site.family_yaml
for each row
execute function family_site.family_touch_updated_at();

drop trigger if exists family_yaml_sync_people on family_site.family_yaml;
create trigger family_yaml_sync_people
after insert or update on family_site.family_yaml
for each row
execute function family_site.family_sync_people();

insert into family_site.family_people (id, display_name)
select
  family_yaml.id,
  family_site.family_compute_display_name(family_yaml.payload, family_yaml.id)
from family_site.family_yaml
on conflict (id) do update
  set display_name = excluded.display_name;

alter table family_site.family_yaml enable row level security;
alter table family_site.family_people enable row level security;

drop policy if exists "family_yaml_public_select" on family_site.family_yaml;
create policy "family_yaml_public_select"
on family_site.family_yaml
for select
to anon, authenticated
using (true);

drop policy if exists "family_yaml_public_insert" on family_site.family_yaml;
create policy "family_yaml_public_insert"
on family_site.family_yaml
for insert
to anon, authenticated
with check (true);

drop policy if exists "family_yaml_public_update" on family_site.family_yaml;
create policy "family_yaml_public_update"
on family_site.family_yaml
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "family_people_public_select" on family_site.family_people;
create policy "family_people_public_select"
on family_site.family_people
for select
to anon, authenticated
using (true);

grant usage on schema family_site to anon, authenticated, service_role;
grant select, insert, update on family_site.family_yaml to anon, authenticated, service_role;
grant select on family_site.family_people to anon, authenticated, service_role;
