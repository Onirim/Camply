-- ══════════════════════════════════════════════════════════════
-- Camply — Partie secrète des personnages (visible propriétaire uniquement)
-- À coller dans : Supabase Dashboard > SQL Editor > New query
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.character_secrets (
  character_id UUID PRIMARY KEY REFERENCES public.characters(id) ON DELETE CASCADE,
  content      TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS on_character_secrets_updated ON public.character_secrets;
CREATE TRIGGER on_character_secrets_updated
  BEFORE UPDATE ON public.character_secrets
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.character_secrets ENABLE ROW LEVEL SECURITY;

-- Seul le propriétaire ACTUEL du personnage (même si public) peut lire/écrire
DROP POLICY IF EXISTS "character_secrets_owner" ON public.character_secrets;
CREATE POLICY "character_secrets_owner" ON public.character_secrets FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.characters c
    WHERE c.id = character_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.characters c
    WHERE c.id = character_id AND c.user_id = auth.uid()
  ));
