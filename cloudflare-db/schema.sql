PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS family_yaml (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS family_people (
  id TEXT PRIMARY KEY REFERENCES family_yaml(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_family_people_display_name
ON family_people(display_name);

DROP TRIGGER IF EXISTS family_yaml_set_updated_at;
CREATE TRIGGER family_yaml_set_updated_at
AFTER UPDATE ON family_yaml
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE family_yaml
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS family_yaml_sync_people_after_insert;
CREATE TRIGGER family_yaml_sync_people_after_insert
AFTER INSERT ON family_yaml
FOR EACH ROW
BEGIN
  INSERT OR REPLACE INTO family_people (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(
        TRIM(
          CASE
            WHEN json_type(NEW.payload, '$.birth_name') = 'text' THEN json_extract(NEW.payload, '$.birth_name')
            WHEN json_type(NEW.payload, '$.birth_name') = 'object' THEN TRIM(
              COALESCE(NULLIF(TRIM(json_extract(NEW.payload, '$.birth_name.surname')), '') || ' ', '') ||
              COALESCE(NULLIF(TRIM(json_extract(NEW.payload, '$.birth_name.first_name')), '') || ' ', '') ||
              COALESCE(TRIM(json_extract(NEW.payload, '$.birth_name.patronymic')), '')
            )
            ELSE ''
          END
        ),
        ''
      ),
      NULLIF(TRIM(NEW.id), ''),
      '???'
    )
  );
END;

DROP TRIGGER IF EXISTS family_yaml_sync_people_after_update;
CREATE TRIGGER family_yaml_sync_people_after_update
AFTER UPDATE ON family_yaml
FOR EACH ROW
BEGIN
  INSERT OR REPLACE INTO family_people (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(
        TRIM(
          CASE
            WHEN json_type(NEW.payload, '$.birth_name') = 'text' THEN json_extract(NEW.payload, '$.birth_name')
            WHEN json_type(NEW.payload, '$.birth_name') = 'object' THEN TRIM(
              COALESCE(NULLIF(TRIM(json_extract(NEW.payload, '$.birth_name.surname')), '') || ' ', '') ||
              COALESCE(NULLIF(TRIM(json_extract(NEW.payload, '$.birth_name.first_name')), '') || ' ', '') ||
              COALESCE(TRIM(json_extract(NEW.payload, '$.birth_name.patronymic')), '')
            )
            ELSE ''
          END
        ),
        ''
      ),
      NULLIF(TRIM(NEW.id), ''),
      '???'
    )
  );
END;

INSERT OR REPLACE INTO family_people (id, display_name)
SELECT
  family_yaml.id,
  COALESCE(
    NULLIF(
      TRIM(
        CASE
          WHEN json_type(family_yaml.payload, '$.birth_name') = 'text' THEN json_extract(family_yaml.payload, '$.birth_name')
          WHEN json_type(family_yaml.payload, '$.birth_name') = 'object' THEN TRIM(
            COALESCE(NULLIF(TRIM(json_extract(family_yaml.payload, '$.birth_name.surname')), '') || ' ', '') ||
            COALESCE(NULLIF(TRIM(json_extract(family_yaml.payload, '$.birth_name.first_name')), '') || ' ', '') ||
            COALESCE(TRIM(json_extract(family_yaml.payload, '$.birth_name.patronymic')), '')
          )
          ELSE ''
        END
      ),
      ''
    ),
    NULLIF(TRIM(family_yaml.id), ''),
    '???'
  )
FROM family_yaml;
