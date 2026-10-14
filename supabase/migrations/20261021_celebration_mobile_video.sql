-- Dashboard banners on phones (Option 3): an optional phone-shaped video per celebration/event,
-- played on phones instead of the wide desktop video. The phone image already exists
-- (banner_mobile_image_base64, 20261008_celebration_mobile_banner.sql). Safe to re-run.
alter table public.hr_celebration_events add column if not exists banner_mobile_video_url text;
