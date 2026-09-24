import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_WEBHOOK_SECRET = Deno.env.get("CRM_WEBHOOK_SECRET") || "";

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function verifyAuth(req: Request): boolean {
  if (!CRM_WEBHOOK_SECRET) return true;
  const provided = req.headers.get("x-webhook-secret") || "";
  if (provided === CRM_WEBHOOK_SECRET) return true;
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader === `Bearer ${CRM_WEBHOOK_SECRET}`) return true;
  return false;
}

interface EnrollmentPayload {
  event?: string;
  crm_student_id?: string;
  crm_enrollment_id?: string;
  crm_lead_id?: string;
  student_name?: string;
  name?: string;
  phone?: string;
  contact?: string;
  email?: string;
  course_name?: string;
  course?: string;
  counselor_name?: string;
  counselor?: string;
  counselor_id?: string;
  enrollment_date?: string;
  preferred_timing?: string;
  preferred_start_date?: string;
  batch_id?: string;
  notes?: string;
  lead_source?: string;
  stage?: string;
}

async function matchCourse(courseName: string): Promise<{ id: string; name: string } | null> {
  const mapping = await sb
    .from("crm_course_mappings")
    .select("course_id, courses(id, name)")
    .eq("crm_course_name", courseName)
    .maybeSingle();
  if (mapping.data?.courses) {
    const c = mapping.data.courses as unknown as { id: string; name: string };
    return c;
  }
  const direct = await sb
    .from("courses")
    .select("id, name")
    .or(`name.ilike.%${courseName}%,code.ilike.%${courseName}%`)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (direct.data) {
    await sb.from("crm_course_mappings").upsert(
      { crm_course_name: courseName, course_id: direct.data.id },
      { onConflict: "crm_course_name" }
    );
    return direct.data;
  }
  return null;
}

async function findExistingStudent(
  crmStudentId?: string,
  phone?: string,
  email?: string
): Promise<{ id: string; uin: string } | null> {
  if (crmStudentId) {
    const { data } = await sb
      .from("students")
      .select("id, uin")
      .eq("crm_student_id", crmStudentId)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await sb
      .from("students")
      .select("id, uin")
      .ilike("contact", phone)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await sb
      .from("students")
      .select("id, uin")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

function generateUin(): string {
  return "BRK" + Date.now().toString().slice(-8);
}

async function resolveCounsellorId(counselorName?: string): Promise<string | null> {
  if (!counselorName) return null;
  // Try exact match first
  const { data: exact } = await sb
    .from("hr_employees")
    .select("id")
    .eq("division", "sales")
    .ilike("full_name", counselorName.trim())
    .limit(1)
    .maybeSingle();
  if (exact?.id) return exact.id;
  // Fuzzy: strip spaces and compare — handles "Thayee Krishna" vs "Thayeekrishna"
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const needle = norm(counselorName);
  const { data: all } = await sb
    .from("hr_employees")
    .select("id, full_name")
    .eq("division", "sales");
  const match = (all || []).find((e) => norm(e.full_name) === needle);
  return match?.id || null;
}

async function processLead(payload: EnrollmentPayload) {
  const crmLeadId = payload.crm_lead_id;
  const name = payload.student_name || payload.name;
  const phone = payload.phone || payload.contact;
  const email = payload.email;
  const courseInterest = payload.course_name || payload.course;
  const counselor = payload.counselor_name || payload.counselor;
  const stage = payload.stage || "New";
  const leadSource = payload.lead_source;

  if (!name) return { ok: false, error: "name is required", status: 400 };

  const counsellorId = await resolveCounsellorId(counselor);

  const row: Record<string, unknown> = {
    name,
    phone: phone || null,
    email: email || null,
    course_interest: courseInterest || null,
    lead_source: leadSource || null,
    counselor_name: counselor || null,
    counsellor_id: counsellorId,
    stage,
    notes: payload.notes || null,
    crm_data: payload as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };

  if (crmLeadId) {
    const { data: existing } = await sb
      .from("crm_leads")
      .select("id")
      .eq("crm_lead_id", crmLeadId)
      .maybeSingle();

    if (existing) {
      await sb.from("crm_leads").update(row).eq("id", existing.id);
      return { ok: true, crm_lead_id: crmLeadId, updated: true };
    }
    row.crm_lead_id = crmLeadId;
  }

  row.created_at = new Date().toISOString();
  const { error } = await sb.from("crm_leads").insert(row);
  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true, crm_lead_id: crmLeadId, created: true };
}

async function processLeadConversion(payload: EnrollmentPayload) {
  const crmLeadId = payload.crm_lead_id;
  if (crmLeadId) {
    const result = await processEnrollment(payload);
    if (result.ok && "student_uin" in result) {
      await sb.from("crm_leads").update({
        stage: "Enrolled",
        student_uin: result.student_uin,
        converted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("crm_lead_id", crmLeadId);
    }
    return result;
  }
  return processEnrollment(payload);
}

async function processEnrollment(payload: EnrollmentPayload) {
  const startMs = Date.now();
  const crmEnrollmentId = payload.crm_enrollment_id;
  const studentName = payload.student_name || payload.name;
  const phone = payload.phone || payload.contact;
  const email = payload.email;
  const courseName = payload.course_name || payload.course;
  const counselor = payload.counselor_name || payload.counselor;
  const enrollmentDate = payload.enrollment_date || new Date().toISOString().slice(0, 10);
  const preferredSlot = payload.preferred_timing;
  const batchId = payload.batch_id;
  const counsellorId = await resolveCounsellorId(counselor);

  if (!studentName) {
    return { ok: false, error: "student_name is required", status: 400 };
  }

  if (crmEnrollmentId) {
    const { data: existing } = await sb
      .from("crm_webhook_events")
      .select("id, student_id, status")
      .eq("crm_enrollment_id", crmEnrollmentId)
      .eq("status", "processed")
      .limit(1)
      .maybeSingle();
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        student_id: existing.student_id,
        message: "Already processed",
      };
    }
  }

  const eventLog = await sb.from("crm_webhook_events").insert({
    crm_enrollment_id: crmEnrollmentId || null,
    event_type: payload.event || "student.enrolled",
    payload: payload as unknown as Record<string, unknown>,
    status: "received",
  }).select("id").single();
  const eventId = eventLog.data?.id;

  try {
    let course: { id: string; name: string } | null = null;
    let courseUnmatched = false;
    if (courseName) {
      course = await matchCourse(courseName);
      if (!course) courseUnmatched = true;
    }

    const existingStudent = await findExistingStudent(
      payload.crm_student_id,
      phone,
      email
    );

    let studentId: string;
    let studentUin: string;

    if (existingStudent) {
      studentId = existingStudent.id;
      studentUin = existingStudent.uin;
      const upd: Record<string, unknown> = {
        crm_student_id: payload.crm_student_id || undefined,
        crm_enrollment_id: crmEnrollmentId || undefined,
        crm_source: "xale",
      };
      if (email) upd.email = email;
      if (phone) upd.contact = phone;
      if (course) upd.programme = course.name;
      if (counselor) upd.source_counsellor = counselor;
      if (counsellorId) upd.counsellor_id = counsellorId;
      if (preferredSlot) upd.preferred_slot = preferredSlot;
      if (!existingStudent.uin) upd.uin = generateUin();
      const cleanUpd = Object.fromEntries(
        Object.entries(upd).filter(([, v]) => v !== undefined)
      );
      await sb.from("students").update(cleanUpd).eq("id", studentId);
      if (!existingStudent.uin) studentUin = cleanUpd.uin as string;
    } else {
      studentUin = generateUin();
      const ins: Record<string, unknown> = {
        uin: studentUin,
        name: studentName,
        contact: phone || null,
        email: email || null,
        programme: course ? course.name : courseName || null,
        status: "New",
        source_counsellor: counselor || null,
        counsellor_id: counsellorId,
        enrolled_date: enrollmentDate,
        preferred_slot: preferredSlot || null,
        crm_student_id: payload.crm_student_id || null,
        crm_enrollment_id: crmEnrollmentId || null,
        crm_source: "xale",
      };
      const { data: newStudent, error: insErr } = await sb
        .from("students")
        .insert(ins)
        .select("id")
        .single();
      if (insErr) throw new Error("Insert student failed: " + insErr.message);
      studentId = newStudent.id;
    }

    let batchResult = null;
    if (batchId) {
      const { data: batchCheck } = await sb
        .from("batches")
        .select("id, course_id, programme")
        .eq("id", batchId)
        .maybeSingle();
      if (batchCheck) {
        if (course && batchCheck.course_id && batchCheck.course_id !== course.id) {
          batchResult = { assigned: false, reason: "Batch course mismatch" };
        } else {
          const rpcRes = await sb.rpc("enroll_student_in_batch", {
            p_batch_id: batchId,
            p_student_id: studentId,
          });
          if (rpcRes.error) {
            batchResult = { assigned: false, reason: rpcRes.error.message };
          } else {
            const r = rpcRes.data as { ok: boolean; error?: string; full?: boolean };
            batchResult = r.ok
              ? { assigned: true, full: r.full || false }
              : { assigned: false, reason: r.error };
          }
        }
      } else {
        batchResult = { assigned: false, reason: "Batch not found" };
      }
    }

    const processingMs = Date.now() - startMs;
    if (eventId) {
      await sb.from("crm_webhook_events").update({
        status: "processed",
        student_id: studentId,
        processing_ms: processingMs,
        processed_at: new Date().toISOString(),
      }).eq("id", eventId);
    }

    return {
      ok: true,
      student_id: studentId,
      student_uin: studentUin,
      is_new: !existingStudent,
      course_matched: !!course,
      course_unmatched: courseUnmatched,
      batch: batchResult,
      processing_ms: processingMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (eventId) {
      await sb.from("crm_webhook_events").update({
        status: "failed",
        error_message: msg,
        processing_ms: Date.now() - startMs,
      }).eq("id", eventId);
    }
    throw err;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!verifyAuth(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: EnrollmentPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const event = payload.event || "student.enrolled";

  if (event === "status.check") {
    const eid = payload.crm_enrollment_id;
    if (!eid) return json({ error: "crm_enrollment_id required" }, 400);
    const { data } = await sb
      .from("crm_webhook_events")
      .select("id, status, student_id, error_message, processed_at")
      .eq("crm_enrollment_id", eid)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return json({ ok: true, event: data || null });
  }

  if (event === "student.enrolled" || event === "enrollment.updated") {
    try {
      const result = await processEnrollment(payload);
      if ("status" in result && typeof result.status === "number") {
        return json(result, result.status as number);
      }
      return json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg }, 500);
    }
  }

  if (event === "lead.created" || event === "lead.updated" || event === "lead.assigned") {
    try {
      const result = await processLead(payload);
      if ("status" in result && typeof result.status === "number") {
        return json(result, result.status as number);
      }
      return json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg }, 500);
    }
  }

  if (event === "lead.converted") {
    try {
      const result = await processLeadConversion(payload);
      return json(result, "status" in result ? (result.status as number) : 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg }, 500);
    }
  }

  if (event === "enrollment.cancelled") {
    const crmEnrollmentId = payload.crm_enrollment_id;
    if (!crmEnrollmentId) return json({ error: "crm_enrollment_id required" }, 400);
    const { data: student } = await sb
      .from("students")
      .select("id")
      .eq("crm_enrollment_id", crmEnrollmentId)
      .maybeSingle();
    if (student) {
      await sb.from("students").update({ status: "Cancelled" }).eq("id", student.id);
    }
    await sb.from("crm_webhook_events").insert({
      crm_enrollment_id: crmEnrollmentId,
      event_type: "enrollment.cancelled",
      payload: payload as unknown as Record<string, unknown>,
      status: "processed",
      student_id: student?.id || null,
      processed_at: new Date().toISOString(),
    });
    return json({ ok: true, cancelled: !!student });
  }

  return json({ error: "Unknown event type: " + event }, 400);
});
