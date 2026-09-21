-- Upcoming Batches & Enrollment workflow
-- Run this in Supabase SQL Editor

-- 1. New columns on batches
ALTER TABLE batches ADD COLUMN IF NOT EXISTS enrollment_status text DEFAULT 'draft';
ALTER TABLE batches ADD COLUMN IF NOT EXISTS enrollment_deadline date;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS sales_notes text;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS published_at timestamptz;

-- 2. Atomic enrollment RPC (prevents overbooking via row-level lock)
CREATE OR REPLACE FUNCTION enroll_student_in_batch(
  p_batch_id uuid,
  p_student_id uuid
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_batch   batches%ROWTYPE;
  v_student students%ROWTYPE;
  v_count   integer;
BEGIN
  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Batch not found');
  END IF;

  IF v_batch.status NOT IN ('upcoming', 'active') THEN
    RETURN json_build_object('ok', false, 'error', 'Batch is not accepting enrollments (status: ' || coalesce(v_batch.status,'null') || ')');
  END IF;

  IF v_batch.enrollment_status NOT IN ('open') THEN
    RETURN json_build_object('ok', false, 'error', 'Enrollment is ' || coalesce(v_batch.enrollment_status,'closed'));
  END IF;

  SELECT * INTO v_student FROM students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Student not found');
  END IF;

  IF v_student.batch_id = p_batch_id THEN
    RETURN json_build_object('ok', false, 'error', 'Student already enrolled in this batch');
  END IF;

  SELECT count(*) INTO v_count FROM students WHERE batch_id = p_batch_id;

  IF v_batch.capacity IS NOT NULL AND v_batch.capacity > 0 AND v_count >= v_batch.capacity THEN
    UPDATE batches SET enrollment_status = 'full' WHERE id = p_batch_id AND enrollment_status = 'open';
    RETURN json_build_object('ok', false, 'error', 'Batch is full (' || v_count || '/' || v_batch.capacity || ')');
  END IF;

  UPDATE students SET
    batch_id = p_batch_id,
    batch_name = v_batch.name,
    trainer_name = v_batch.trainer_name,
    programme = v_batch.programme,
    status = CASE WHEN status IN ('New','') OR status IS NULL THEN 'In Progress' ELSE status END
  WHERE id = p_student_id;

  IF v_batch.capacity IS NOT NULL AND v_batch.capacity > 0 AND (v_count + 1) >= v_batch.capacity THEN
    UPDATE batches SET enrollment_status = 'full' WHERE id = p_batch_id AND enrollment_status = 'open';
  END IF;

  RETURN json_build_object(
    'ok', true,
    'enrolled', v_count + 1,
    'capacity', v_batch.capacity,
    'full', (v_batch.capacity IS NOT NULL AND v_batch.capacity > 0 AND (v_count + 1) >= v_batch.capacity)
  );
END;
$$;

-- 3. Unenroll RPC
CREATE OR REPLACE FUNCTION unenroll_student_from_batch(
  p_batch_id uuid,
  p_student_id uuid
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_batch  batches%ROWTYPE;
  v_student students%ROWTYPE;
  v_count  integer;
BEGIN
  SELECT * INTO v_batch FROM batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Batch not found');
  END IF;

  SELECT * INTO v_student FROM students WHERE id = p_student_id;
  IF NOT FOUND OR v_student.batch_id IS DISTINCT FROM p_batch_id THEN
    RETURN json_build_object('ok', false, 'error', 'Student not enrolled in this batch');
  END IF;

  UPDATE students SET batch_id = NULL, batch_name = NULL WHERE id = p_student_id;

  SELECT count(*) INTO v_count FROM students WHERE batch_id = p_batch_id;
  IF v_batch.enrollment_status = 'full' AND (v_batch.capacity IS NULL OR v_count < v_batch.capacity) THEN
    UPDATE batches SET enrollment_status = 'open' WHERE id = p_batch_id;
  END IF;

  RETURN json_build_object('ok', true, 'enrolled', v_count, 'capacity', v_batch.capacity);
END;
$$;
