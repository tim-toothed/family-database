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

create table if not exists family_site.text_documents (
  id text primary key,
  title text not null,
  description text,
  source_type text not null,
  source_path text not null,
  extractor jsonb,
  content_hash text,
  generated_at timestamptz,
  block_count integer not null default 0,
  mention_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint text_documents_block_count_non_negative check (block_count >= 0),
  constraint text_documents_mention_count_non_negative check (mention_count >= 0),
  constraint text_documents_extractor_is_object check (
    extractor is null or jsonb_typeof(extractor) = 'object'
  )
);

alter table if exists family_site.text_documents
  add column if not exists content_hash text;

create table if not exists family_site.text_document_blocks (
  id bigint generated always as identity primary key,
  document_id text not null references family_site.text_documents(id) on delete cascade,
  block_index integer not null,
  kind text not null,
  text text not null,
  mention_count integer not null default 0,
  constraint text_document_blocks_document_index_unique unique (document_id, block_index),
  constraint text_document_blocks_block_index_non_negative check (block_index >= 0),
  constraint text_document_blocks_mention_count_non_negative check (mention_count >= 0)
);

create index if not exists text_document_blocks_document_id_idx
  on family_site.text_document_blocks (document_id, block_index);

create table if not exists family_site.text_document_mentions (
  id bigint generated always as identity primary key,
  document_id text not null references family_site.text_documents(id) on delete cascade,
  block_id bigint not null references family_site.text_document_blocks(id) on delete cascade,
  block_index integer not null,
  mention_index integer not null,
  kind text not null,
  text text not null,
  start_offset integer not null,
  end_offset integer not null,
  source text not null,
  constraint text_document_mentions_document_block_mention_unique unique (document_id, block_index, mention_index),
  constraint text_document_mentions_kind_valid check (kind in ('name', 'kinship')),
  constraint text_document_mentions_block_index_non_negative check (block_index >= 0),
  constraint text_document_mentions_mention_index_non_negative check (mention_index >= 0),
  constraint text_document_mentions_offsets_valid check (end_offset > start_offset)
);

create index if not exists text_document_mentions_document_id_idx
  on family_site.text_document_mentions (document_id, block_index);

create index if not exists text_document_mentions_block_id_idx
  on family_site.text_document_mentions (block_id, mention_index);

create or replace function family_site.import_text_document(
  p_document jsonb,
  p_blocks jsonb default '[]'::jsonb,
  p_mentions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = family_site, public
as $$
declare
  v_document_id text := nullif(btrim(p_document ->> 'id'), '');
  v_content_hash text := nullif(btrim(p_document ->> 'content_hash'), '');
  v_block_count integer := greatest(coalesce((p_document ->> 'block_count')::integer, jsonb_array_length(coalesce(p_blocks, '[]'::jsonb))), 0);
  v_mention_count integer := greatest(coalesce((p_document ->> 'mention_count')::integer, jsonb_array_length(coalesce(p_mentions, '[]'::jsonb))), 0);
  v_existing_hash text;
  v_existing_block_count integer;
  v_existing_mention_count integer;
begin
  if coalesce(jsonb_typeof(p_document), '') <> 'object' then
    raise exception 'p_document must be a JSON object';
  end if;

  if coalesce(jsonb_typeof(p_blocks), 'array') <> 'array' then
    raise exception 'p_blocks must be a JSON array';
  end if;

  if coalesce(jsonb_typeof(p_mentions), 'array') <> 'array' then
    raise exception 'p_mentions must be a JSON array';
  end if;

  if v_document_id is null then
    raise exception 'p_document.id is required';
  end if;

  select
    text_documents.content_hash,
    text_documents.block_count,
    text_documents.mention_count
  into
    v_existing_hash,
    v_existing_block_count,
    v_existing_mention_count
  from family_site.text_documents as text_documents
  where text_documents.id = v_document_id;

  if v_content_hash is not null and v_existing_hash = v_content_hash then
    return jsonb_build_object(
      'document_id', v_document_id,
      'block_count', coalesce(v_existing_block_count, 0),
      'mention_count', coalesce(v_existing_mention_count, 0),
      'skipped', true
    );
  end if;

  insert into family_site.text_documents (
    id,
    title,
    description,
    source_type,
    source_path,
    extractor,
    content_hash,
    generated_at,
    block_count,
    mention_count
  )
  values (
    v_document_id,
    coalesce(nullif(btrim(p_document ->> 'title'), ''), v_document_id),
    nullif(btrim(p_document ->> 'description'), ''),
    coalesce(nullif(btrim(p_document ->> 'source_type'), ''), 'unknown'),
    coalesce(p_document ->> 'source_path', ''),
    case
      when jsonb_typeof(p_document -> 'extractor') = 'object'
        then p_document -> 'extractor'
      else null
    end,
    v_content_hash,
    case
      when nullif(btrim(p_document ->> 'generated_at'), '') is null
        then null
      else (p_document ->> 'generated_at')::timestamptz
    end,
    v_block_count,
    v_mention_count
  )
  on conflict (id) do update
    set title = excluded.title,
        description = excluded.description,
        source_type = excluded.source_type,
        source_path = excluded.source_path,
        extractor = excluded.extractor,
        content_hash = excluded.content_hash,
        generated_at = excluded.generated_at,
        block_count = excluded.block_count,
        mention_count = excluded.mention_count;

  delete from family_site.text_document_blocks
  where document_id = v_document_id;

  insert into family_site.text_document_blocks (
    document_id,
    block_index,
    kind,
    text,
    mention_count
  )
  select
    v_document_id,
    coalesce(block_data.block_index, 0),
    coalesce(nullif(btrim(block_data.kind), ''), 'paragraph'),
    coalesce(block_data.text, ''),
    greatest(coalesce(block_data.mention_count, 0), 0)
  from jsonb_to_recordset(coalesce(p_blocks, '[]'::jsonb)) as block_data(
    block_index integer,
    kind text,
    text text,
    mention_count integer
  )
  order by block_data.block_index;

  insert into family_site.text_document_mentions (
    document_id,
    block_id,
    block_index,
    mention_index,
    kind,
    text,
    start_offset,
    end_offset,
    source
  )
  select
    v_document_id,
    block_row.id,
    mention_data.block_index,
    mention_data.mention_index,
    mention_data.kind,
    mention_data.text,
    mention_data.start_offset,
    mention_data.end_offset,
    mention_data.source
  from jsonb_to_recordset(coalesce(p_mentions, '[]'::jsonb)) as mention_data(
    block_index integer,
    mention_index integer,
    kind text,
    text text,
    start_offset integer,
    end_offset integer,
    source text
  )
  inner join family_site.text_document_blocks as block_row
    on block_row.document_id = v_document_id
   and block_row.block_index = mention_data.block_index
  order by mention_data.block_index, mention_data.mention_index;

  return jsonb_build_object(
    'document_id', v_document_id,
    'block_count', v_block_count,
    'mention_count', v_mention_count,
    'skipped', false
  );
end;
$$;

drop trigger if exists text_documents_touch_updated_at on family_site.text_documents;
create trigger text_documents_touch_updated_at
before insert or update on family_site.text_documents
for each row
execute function family_site.family_touch_updated_at();

alter table family_site.text_documents enable row level security;
alter table family_site.text_document_blocks enable row level security;
alter table family_site.text_document_mentions enable row level security;

drop policy if exists "text_documents_public_select" on family_site.text_documents;
create policy "text_documents_public_select"
on family_site.text_documents
for select
to anon, authenticated
using (true);

drop policy if exists "text_document_blocks_public_select" on family_site.text_document_blocks;
create policy "text_document_blocks_public_select"
on family_site.text_document_blocks
for select
to anon, authenticated
using (true);

drop policy if exists "text_document_mentions_public_select" on family_site.text_document_mentions;
create policy "text_document_mentions_public_select"
on family_site.text_document_mentions
for select
to anon, authenticated
using (true);

grant select on family_site.text_documents to anon, authenticated, service_role;
grant select on family_site.text_document_blocks to anon, authenticated, service_role;
grant select on family_site.text_document_mentions to anon, authenticated, service_role;
grant insert, update, delete on family_site.text_documents to service_role;
grant insert, update, delete on family_site.text_document_blocks to service_role;
grant insert, update, delete on family_site.text_document_mentions to service_role;
grant usage, select on all sequences in schema family_site to service_role;
grant execute on function family_site.import_text_document(jsonb, jsonb, jsonb) to service_role;
