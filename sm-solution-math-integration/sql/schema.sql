-- SM Solution Math CRM - schema inicial Supabase/PostgreSQL
create extension if not exists pgcrypto;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text unique,
  email text,
  company text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  name text,
  company text,
  phone text,
  email text,
  city text,
  segment text,
  source text not null default 'manual',
  source_detail text,
  status text not null default 'novo',
  estimated_value numeric(12,2) not null default 0,
  notes text,
  whatsapp_opt_in boolean not null default false,
  whatsapp_opt_in_at timestamptz,
  last_message_at timestamptz,
  external_lead_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_created_at_idx on public.leads(created_at desc);
create index if not exists leads_source_idx on public.leads(source);
create index if not exists leads_phone_idx on public.leads(phone);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  channel text not null default 'whatsapp',
  status text not null default 'open',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(contact_id, channel)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  provider_message_id text unique,
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null default 'text',
  body text,
  delivery_status text not null default 'received',
  raw_payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null unique,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- As tabelas não ficam expostas ao cliente anônimo. O backend usa SERVICE_ROLE_KEY.
alter table public.contacts enable row level security;
alter table public.leads enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.webhook_events enable row level security;

-- Não crie políticas públicas para estas tabelas. Quando houver login multiusuário,
-- adicionar organization_id/user_id e políticas RLS por organização.
