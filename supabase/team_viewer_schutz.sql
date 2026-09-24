-- Slesdrafts · Build 153
-- Zuschauer (viewer) dürfen Team-Drafts nur lesen – nicht anlegen, bearbeiten oder löschen.
-- Einmal im Supabase SQL-Editor ausführen. Kann gefahrlos mehrfach ausgeführt werden.
--
-- "as restrictive" wird zusätzlich zu den bestehenden Regeln geprüft (UND-Verknüpfung):
-- bestehende Rechte bleiben, es kommt nur die Rollen-Bedingung dazu.

alter table public.team_drafts enable row level security;

drop policy if exists team_drafts_nur_bearbeiter_insert on public.team_drafts;
create policy team_drafts_nur_bearbeiter_insert on public.team_drafts
  as restrictive for insert to authenticated
  with check (exists (
    select 1 from public.team_members m
    where m.team_id = team_drafts.team_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'lead', 'editor')
  ));

drop policy if exists team_drafts_nur_bearbeiter_update on public.team_drafts;
create policy team_drafts_nur_bearbeiter_update on public.team_drafts
  as restrictive for update to authenticated
  using (exists (
    select 1 from public.team_members m
    where m.team_id = team_drafts.team_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'lead', 'editor')
  ))
  with check (exists (
    select 1 from public.team_members m
    where m.team_id = team_drafts.team_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'lead', 'editor')
  ));

drop policy if exists team_drafts_nur_bearbeiter_delete on public.team_drafts;
create policy team_drafts_nur_bearbeiter_delete on public.team_drafts
  as restrictive for delete to authenticated
  using (exists (
    select 1 from public.team_members m
    where m.team_id = team_drafts.team_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'lead', 'editor')
  ));
