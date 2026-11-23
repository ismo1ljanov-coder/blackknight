-- BlackKnight / UniVoice database schema.
-- Reconstructed from api/index.js (Nov 2026) for the new Neon project; safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  username text,
  photo_url text,
  major text,
  year text,
  interests text[] NOT NULL DEFAULT '{}',
  teach text,
  learn text,
  contact text,
  knight_no integer UNIQUE,
  title text,
  role text,
  position text,
  scope text,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  user_id text PRIMARY KEY,
  added_by text,
  scope text,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_starts (
  user_id text PRIMARY KEY,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dm_sessions (
  user_id text PRIMARY KEY,
  peer_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
  user_id text NOT NULL,
  kind text NOT NULL,
  ok boolean,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS selftest (
  id serial PRIMARY KEY,
  result text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
  user_id text PRIMARY KEY,
  referrer_id text NOT NULL,
  credited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_requests (
  id serial PRIMARY KEY,
  from_id text NOT NULL,
  to_id text NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  UNIQUE (from_id, to_id)
);

-- Problems (murojaatlar) and votes
CREATE TABLE IF NOT EXISTS problems (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'muammo',
  title text NOT NULL,
  body text,
  category text,
  anon boolean NOT NULL DEFAULT false,
  author_id text,
  status text NOT NULL DEFAULT 'yangi',
  notified_votes integer NOT NULL DEFAULT 0,
  assigned_pos text,
  routed_at timestamptz,
  dekanat_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS votes (
  problem_id integer NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  PRIMARY KEY (problem_id, user_id)
);
CREATE TABLE IF NOT EXISTS problem_comments (
  id serial PRIMARY KEY,
  problem_id integer NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  body text NOT NULL,
  team boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS problem_photos (
  id serial PRIMARY KEY,
  problem_id integer NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  pos integer NOT NULL DEFAULT 0,
  mime text NOT NULL,
  data text NOT NULL
);

-- Clubs
CREATE TABLE IF NOT EXISTS clubs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  emoji text,
  description text,
  tg_link text,
  tg_channel text,
  leader_id text,
  active boolean NOT NULL DEFAULT true,
  logo text, logo_mime text, logo_v integer NOT NULL DEFAULT 0,
  cover text, cover_mime text, cover_v integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS club_members (
  club_id integer NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);

-- Events
CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  date_only boolean NOT NULL DEFAULT false,
  place text,
  capacity integer,
  link text,
  price integer,
  club_id integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rsvps (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS event_guests (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  name text,
  username text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS event_attendance (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  came boolean,
  status text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS event_ratings (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  stars integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS event_covers (
  event_id integer PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  mime text NOT NULL,
  data text NOT NULL,
  v integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS club_attendance (
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  marked_by text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- Volunteers and service hours
CREATE TABLE IF NOT EXISTS volunteer_interest (
  user_id text PRIMARY KEY,
  source text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_log (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  hours numeric NOT NULL,
  note text,
  event_id integer,
  added_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vol_tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  place text,
  starts_at timestamptz,
  slots integer,
  hours numeric,
  owner_id text,
  club_id integer,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vol_signups (
  task_id integer NOT NULL REFERENCES vol_tasks(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'joined',
  log_id integer,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  hours numeric,
  level text,
  issued_at timestamptz NOT NULL DEFAULT now()
);

-- Team positions and applications
CREATE TABLE IF NOT EXISTS positions (
  id text PRIMARY KEY,
  block text,
  emoji text,
  title text NOT NULL,
  duty text,
  req text,
  hours text,
  faculty text,
  full_access boolean NOT NULL DEFAULT false,
  sort integer NOT NULL DEFAULT 0,
  open boolean NOT NULL DEFAULT true,
  holder_id text,
  holder_since timestamptz
);
CREATE TABLE IF NOT EXISTS applications (
  id serial PRIMARY KEY,
  position_id text NOT NULL,
  user_id text NOT NULL,
  why text,
  exp text,
  hours text,
  link text,
  status text NOT NULL DEFAULT 'new',
  note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Market
CREATE TABLE IF NOT EXISTS listings (
  id serial PRIMARY KEY,
  seller_id text NOT NULL,
  title text NOT NULL,
  description text,
  price integer,
  category text,
  condition text,
  status text NOT NULL DEFAULT 'faol',
  sold_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS listing_photos (
  id serial PRIMARY KEY,
  listing_id integer NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  pos integer NOT NULL DEFAULT 0,
  mime text NOT NULL,
  data text NOT NULL
);
CREATE TABLE IF NOT EXISTS market_reports (
  listing_id integer NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, reporter_id)
);
CREATE TABLE IF NOT EXISTS market_wants (
  listing_id integer NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id text NOT NULL,
  seller_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, buyer_id)
);

CREATE INDEX IF NOT EXISTS problems_created_idx ON problems (created_at DESC);
CREATE INDEX IF NOT EXISTS votes_user_idx ON votes (user_id);
CREATE INDEX IF NOT EXISTS events_starts_idx ON events (starts_at);
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen);
