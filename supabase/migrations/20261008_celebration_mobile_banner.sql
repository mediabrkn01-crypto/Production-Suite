-- Phone banner for Celebrations / Special Days. The wide 1920×400 banner becomes unreadable on a
-- phone, so HR can upload a taller image (3:2, e.g. 1080×720) that phones show instead.
-- Without it, phones fall back to the event's popup image (shown whole, never cropped).
alter table public.hr_celebration_events
  add column if not exists banner_mobile_image_base64 text;
