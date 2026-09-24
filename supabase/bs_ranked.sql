-- Slesdrafts · Ranked-Elo-Verlauf
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Die Netlify-Functions schreiben hier jeden neuen Elo-Stand aus dem Spielerprofil hinein
-- (rankedElo, rankedRank, Saison- und Allzeit-Bestwerte). Ohne die Tabelle läuft alles weiter,
-- nur ohne Elo-Verlauf.

create table if not exists public.bs_ranked (
  tag     text        not null,
  t       timestamptz not null default now(),
  elo     integer     not null,
  rank    integer,
  season  integer,
  s_elo   integer,
  s_rank  integer,
  a_elo   integer,
  a_rank  integer,
  primary key (tag, t)
);

-- Nur die Functions (Service-Role-Key) greifen zu, der Browser nie direkt.
alter table public.bs_ranked enable row level security;
