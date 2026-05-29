-- ─────────────────────────────────────────────────────────────
--  CP PERFORMANCE BACKEND — Supabase Schema
--  Run this in Supabase → SQL Editor
-- ─────────────────────────────────────────────────────────────

-- ADMINS
create table admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  password_hash text not null,
  role text default 'admin' check (role in ('superadmin','admin')),
  whatsapp text,
  created_at timestamptz default now()
);

-- PROJECTS (e.g. "31 Floral Drive")
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text,
  total_units integer default 0,
  available_units integer default 0,
  premium_inventory_count integer default 0,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- CHANNEL PARTNERS
create table channel_partners (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  email text,
  whatsapp text not null,        -- primary contact for automation
  phone text,
  firm_name text,
  area text,
  rera_number text,
  imported_at timestamptz default now(),
  created_at timestamptz default now()
);

-- CP ACTIVITY LOG (core data — imported or logged)
create table cp_activity (
  id uuid primary key default gen_random_uuid(),
  cp_id uuid references channel_partners(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  site_visits integer default 0,
  client_referrals integer default 0,
  deals_closed integer default 0,
  last_conversation_at timestamptz,   -- last time CP spoke with sales team
  last_visit_at timestamptz,          -- last site visit date
  last_active_at timestamptz,         -- most recent any activity
  period_start date not null,         -- e.g. 2025-05-01
  period_end date not null,           -- e.g. 2025-05-31
  period_type text default 'monthly' check (period_type in ('weekly','monthly','yearly')),
  score integer default 0,
  tier text default 'inactive' check (tier in ('active','dormant','inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(cp_id, period_start, period_type)
);

-- TIER CLASSIFICATION RULES (per project, configurable)
create table tier_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  period_type text default 'monthly',
  -- ACTIVE thresholds
  active_min_visits integer default 5,
  active_min_deals integer default 1,
  -- DORMANT thresholds  
  dormant_min_visits integer default 1,
  dormant_min_deals integer default 0,
  -- inactivity trigger (days with no activity)
  inactivity_warning_days integer default 7,
  inactivity_critical_days integer default 14,
  inactivity_meeting_days integer default 21,
  created_at timestamptz default now()
);

-- MESSAGES LOG (every whatsapp message sent)
create table messages (
  id uuid primary key default gen_random_uuid(),
  cp_id uuid references channel_partners(id) on delete cascade,
  project_id uuid references projects(id),
  sent_by text default 'system' check (sent_by in ('system','admin','job')),
  trigger_type text,   -- 'inactivity_7d','performance_drop','dormant_support','active_perk','meeting_set','manual','daily_summary','no_conversation'
  channel text default 'whatsapp' check (channel in ('whatsapp','email','sms')),
  template_name text,
  message_body text not null,
  whatsapp_message_id text,         -- ID returned by Meta API
  status text default 'pending' check (status in ('pending','sent','delivered','read','failed')),
  error_details text,
  sent_at timestamptz default now()
);

-- MEETINGS (set for inactive CPs)
create table meetings (
  id uuid primary key default gen_random_uuid(),
  cp_id uuid references channel_partners(id) on delete cascade,
  project_id uuid references projects(id),
  scheduled_by uuid references admins(id),
  scheduled_at timestamptz not null,
  reason text,
  status text default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  notes text,
  created_at timestamptz default now()
);

-- DAILY SUMMARIES (generated and sent every evening)
create table daily_summaries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  summary_date date not null,
  total_cps integer default 0,
  active_count integer default 0,
  dormant_count integer default 0,
  inactive_count integer default 0,
  messages_sent_today integer default 0,
  meetings_set_today integer default 0,
  new_deals_today integer default 0,
  alerts_fired text[],              -- list of CP names that triggered alerts
  summary_json jsonb,               -- full breakdown stored as JSON
  sent_to_admin boolean default false,
  created_at timestamptz default now()
);

-- IMPORTS LOG
create table imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  imported_by uuid references admins(id),
  file_name text,
  total_rows integer,
  success_rows integer,
  failed_rows integer,
  errors jsonb,
  imported_at timestamptz default now()
);

-- ─── INDEXES for performance ───────────────────────────────
create index idx_cp_project on channel_partners(project_id);
create index idx_activity_cp on cp_activity(cp_id);
create index idx_activity_period on cp_activity(period_start, period_type);
create index idx_activity_tier on cp_activity(tier);
create index idx_activity_last_active on cp_activity(last_active_at);
create index idx_messages_cp on messages(cp_id);
create index idx_messages_status on messages(status);
create index idx_messages_sent_at on messages(sent_at);

-- ─── FUNCTION: auto-update updated_at ──────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_activity_updated
  before update on cp_activity
  for each row execute function update_updated_at();

-- ─── SEED: default tier rules for a project ────────────────
-- (run after inserting your first project)
-- insert into tier_rules (project_id) values ('YOUR-PROJECT-UUID');
