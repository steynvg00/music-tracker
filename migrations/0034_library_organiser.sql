-- 0034: library_organiser — Rotor v0.91: pins, folders and a custom order for the Library.
--
-- Additive only: two new tables + one trigger function. Nothing existing is altered or dropped.
-- Numbered 0034 because 0031–0033 belong to the open v0.90 PR (#99); it is independent of them
-- (and of 0025) and can be applied before or after them.
--
-- ROTOR ONLY: pins, folders and the custom order live in these tables and nowhere else. Nothing here
-- (and nothing in v0.91) writes to Spotify: your Spotify library and playlists are not changed.
--
--   library_folders  a folder (name, optional parent: ONE level of nesting, enforced by a trigger),
--                    its place among its siblings, and its pin (pin_pos NOT NULL = pinned).
--   library_items    one row per playlist you organised: which folder it is in (NULL = Library root),
--                    its place in the custom order, its pin. Keys:
--                      spotify:playlist:<id>      a Spotify playlist (managed, own or followed)
--                      rotor:liked                Liked Songs
--                      rotor:collection:<uuid>    a YouTube / SoundCloud collection (pins only, no folders:
--                                                 Elsewhere stays apart from Spotify, 03-ux-ia.md §3)
--                    A playlist you never organised has no row. Removing a playlist on Spotify leaves
--                    its row behind harmlessly (the Library only shows rows for playlists it lists).
--   pin_pos is one sequence shared by folders and items, so pinned folders and playlists share one order.
--   Deleting a folder moves its playlists and subfolders back to the root (ON DELETE SET NULL); it never
--   deletes a playlist. No caps on pins or folders.
-- Size: KBs (a few hundred rows of ~60–100 bytes at most; measured in the v0.91 PR).

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE library_folders (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  parent_id  bigint      REFERENCES library_folders (id) ON DELETE SET NULL,
  position   integer     NOT NULL DEFAULT 0,       -- custom order among its siblings
  pin_pos    integer,                              -- NOT NULL = pinned; order shared with library_items
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE library_items (
  item_key   text        PRIMARY KEY
             CHECK (item_key ~ '^(spotify:playlist:[A-Za-z0-9]{22}|rotor:liked|rotor:collection:[0-9a-f-]{36})$'),
  folder_id  bigint      REFERENCES library_folders (id) ON DELETE SET NULL,
  position   integer     NOT NULL DEFAULT 0,       -- custom order inside its folder (or the root)
  pin_pos    integer,                              -- NOT NULL = pinned
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (folder_id IS NULL OR item_key NOT LIKE 'rotor:collection:%')
);
CREATE INDEX library_items_folder ON library_items (folder_id) WHERE folder_id IS NOT NULL;

-- One level of nesting: a subfolder's parent must be a top-level folder, and a folder that has
-- subfolders can't itself become a subfolder.
CREATE FUNCTION library_folders_one_level() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM library_folders WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'library folders nest one level deep: folder % is already inside a folder', NEW.parent_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM library_folders WHERE parent_id = NEW.id) THEN
      RAISE EXCEPTION 'library folders nest one level deep: folder % has subfolders', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER library_folders_one_level BEFORE INSERT OR UPDATE OF parent_id ON library_folders
  FOR EACH ROW EXECUTE FUNCTION library_folders_one_level();

ALTER TABLE library_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_items   ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (34, 'library_organiser');

COMMIT;
