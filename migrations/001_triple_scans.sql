-- Run this once in the Supabase SQL Editor of the same Supabase project
-- scan-code-reader1 uses. It reuses that project's existing `projects`
-- table (scan-code-reader1's migrations/004_projects_table.sql), so run
-- that one first if it hasn't been.
--
-- One row per physical scan. The three scans of one part -- old 2D label,
-- new 2D label, 1D flag-tag barcode -- share a correlation_id. Kept in its
-- own table, separate from label_scans, so the two tools' histories,
-- reports, and duplicate checks don't mix.

create table if not exists triple_scans (
  id              bigint generated always as identity primary key,
  project         text not null references projects (code),
  correlation_id  uuid not null default gen_random_uuid(),
  label_version   text not null check (label_version in ('old', 'new', 'barcode')),
  raw_code        text not null,
  ebom            text,  -- old/new only (the 1D barcode is a serial, saved whole in raw_code)
  traceability    text,  -- old/new only
  scanned_at      timestamptz not null default now()
);

create index if not exists triple_scans_correlation_id_idx on triple_scans (correlation_id);
create index if not exists triple_scans_raw_code_idx on triple_scans (raw_code);  -- backs the duplicate check
create index if not exists triple_scans_project_scanned_at_idx on triple_scans (project, scanned_at desc);
create index if not exists triple_scans_ebom_idx on triple_scans (ebom);
create index if not exists triple_scans_traceability_idx on triple_scans (traceability);

-- Open access, same as label_scans (no login in this app): the anon key can
-- read, insert, update (only used to attach a correlation_id when
-- completing a set from the "Waiting to be completed" list), and delete
-- (Undo and Delete). Anyone holding the anon key can read/write every row.
alter table triple_scans enable row level security;

drop policy if exists "anon can read triple scans" on triple_scans;
create policy "anon can read triple scans" on triple_scans
  for select to anon, authenticated using (true);

drop policy if exists "anon can insert triple scans" on triple_scans;
create policy "anon can insert triple scans" on triple_scans
  for insert to anon, authenticated with check (true);

drop policy if exists "anon can update triple scans" on triple_scans;
create policy "anon can update triple scans" on triple_scans
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon can delete triple scans" on triple_scans;
create policy "anon can delete triple scans" on triple_scans
  for delete to anon, authenticated using (true);
