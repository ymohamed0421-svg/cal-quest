-- Cal Quest database setup. Paste all of this into Supabase → SQL Editor → Run.
-- Safe to run more than once.

-- Public player card (shown on friends' leaderboards). No food data here.
create table if not exists public.players (
  id uuid primary key references auth.users on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  level int not null default 1,
  xp int not null default 0,
  streak int not null default 0,
  title text not null default 'Rookie',
  theme text,
  stats_day text,
  today_pct int not null default 0,
  cleared_today boolean not null default false,
  boss_dmg int not null default 0,
  gym_streak int not null default 0,
  updated_at timestamptz not null default now()
);
create unique index if not exists players_username_lower on public.players (lower(username));
alter table public.players enable row level security;
drop policy if exists "read players" on public.players;
create policy "read players" on public.players for select to authenticated using (true);
drop policy if exists "insert own player" on public.players;
create policy "insert own player" on public.players for insert to authenticated with check (auth.uid() = id);
drop policy if exists "update own player" on public.players;
create policy "update own player" on public.players for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Private backup of each player's whole app (only they can read it).
create table if not exists public.saves (
  id uuid primary key references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.saves enable row level security;
drop policy if exists "own save" on public.saves;
create policy "own save" on public.saves for all to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Friends: who shows up on my leaderboard.
create table if not exists public.follows (
  follower uuid not null references auth.users on delete cascade,
  followee uuid not null references public.players on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee)
);
alter table public.follows enable row level security;
drop policy if exists "see my follows" on public.follows;
create policy "see my follows" on public.follows for select to authenticated using (auth.uid() = follower or auth.uid() = followee);
drop policy if exists "add my follows" on public.follows;
create policy "add my follows" on public.follows for insert to authenticated with check (auth.uid() = follower and follower <> followee);
drop policy if exists "remove my follows" on public.follows;
create policy "remove my follows" on public.follows for delete to authenticated using (auth.uid() = follower);

-- Push reminder subscriptions (one per phone).
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users on delete cascade,
  sub jsonb not null,
  reminders text[] not null,
  tz text not null,
  sent jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own push subs" on public.push_subs;
create policy "own push subs" on public.push_subs for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- (added later) make sure older setups have the gym streak column
alter table public.players add column if not exists gym_streak int not null default 0;
