-- Close public PostgREST access. Backend uses the postgres role (table owner),
-- which bypasses RLS, so crons and dashboard are unaffected.
-- Applied to production 2026-09-29 via Supabase MCP.
ALTER TABLE public.badge_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_playlists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlist_rank_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liked_songs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.track_metadata        ENABLE ROW LEVEL SECURITY;

-- View must respect the caller's permissions/RLS instead of the owner's.
ALTER VIEW public.unified_plays SET (security_invoker = true);
