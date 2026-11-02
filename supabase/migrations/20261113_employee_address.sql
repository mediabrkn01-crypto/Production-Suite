-- Employee Address Details (HR → Add / Edit Employee).
-- Additive only: nullable text columns on the existing hr_employees row, so existing
-- employees keep working with no address, IDs are untouched and no new table/records.
-- Existing hr_employees RLS/policies apply unchanged.
alter table public.hr_employees
    add column if not exists address_house    text,
    add column if not exists address_line1    text,
    add column if not exists address_line2    text,
    add column if not exists address_city     text,
    add column if not exists address_district text,
    add column if not exists address_state    text,
    add column if not exists address_pincode  text,
    add column if not exists address_country  text;
