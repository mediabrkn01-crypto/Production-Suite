-- One-on-One (OTO) Sessions for Group Courses
-- Run this in Supabase SQL Editor

-- 1. Add configurable OTO session count to courses
ALTER TABLE courses ADD COLUMN IF NOT EXISTS oto_sessions_required integer DEFAULT 0;
COMMENT ON COLUMN courses.oto_sessions_required IS 'Number of individual 1:1 sessions each student must complete in a group course. 0 = none. Typically 1 for 1-month, 2 for 2-month group courses.';

-- 2. OTO session tracking table
CREATE TABLE IF NOT EXISTS oto_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id),
  student_id uuid NOT NULL REFERENCES students(id),
  session_number smallint NOT NULL CHECK (session_number >= 1),
  trainer_id uuid REFERENCES trainers(id),
  session_date date,
  start_time time,
  end_time time,
  duration_minutes smallint NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','scheduled','completed','absent','trainer_leave','postponed')),
  notes text,
  marked_by text,
  marked_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (batch_id, student_id, session_number)
);

CREATE INDEX IF NOT EXISTS idx_oto_batch ON oto_sessions(batch_id);
CREATE INDEX IF NOT EXISTS idx_oto_student ON oto_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_oto_trainer ON oto_sessions(trainer_id);
CREATE INDEX IF NOT EXISTS idx_oto_date ON oto_sessions(session_date);

COMMENT ON TABLE oto_sessions IS 'Individual One-on-One sessions for students enrolled in group courses. Each row = one student''s session attempt.';

-- 3. Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_oto_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_oto_sessions_updated ON oto_sessions;
CREATE TRIGGER trg_oto_sessions_updated
  BEFORE UPDATE ON oto_sessions
  FOR EACH ROW EXECUTE FUNCTION update_oto_sessions_updated_at();

-- 4. Enable RLS
ALTER TABLE oto_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oto_sessions_all" ON oto_sessions
  FOR ALL USING (true) WITH CHECK (true);
