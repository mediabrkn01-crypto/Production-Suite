import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-actor-email",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const actorEmail = req.headers.get("x-actor-email") || "";
    if (!actorEmail) {
      return new Response(JSON.stringify({ error: "Missing x-actor-email header" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: user } = await sb.from("user_roster").select("role").eq("email", actorEmail.toLowerCase()).maybeSingle();
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden: admin role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "save_draft") {
      const { policy_key, settings, effective_date, notes } = body;
      const { data: existing } = await sb.from("hr_policy_config").select("version").eq("policy_key", policy_key).order("version", { ascending: false }).limit(1);
      const nextVersion = (existing && existing[0] ? existing[0].version : 0) + 1;
      const { data: row, error } = await sb.from("hr_policy_config").insert({
        policy_key, version: nextVersion, settings, effective_date: effective_date || new Date().toISOString().slice(0, 10),
        status: "draft", created_by: actorEmail, notes: notes || null,
      }).select().single();
      if (error) throw error;

      await sb.from("hr_policy_audit").insert({
        policy_config_id: row.id, action: "created", actor_email: actorEmail,
        new_settings: settings, reason: notes || "Draft created",
      });

      return new Response(JSON.stringify({ success: true, data: row }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "activate") {
      const { id, policy_key } = body;
      const { data: current } = await sb.from("hr_policy_config").select("*").eq("policy_key", policy_key).eq("status", "active").maybeSingle();
      if (current) {
        await sb.from("hr_policy_config").update({ status: "superseded", superseded_at: new Date().toISOString() }).eq("id", current.id);
      }
      const { data: activated, error } = await sb.from("hr_policy_config").update({
        status: "active", approved_by: actorEmail, approved_at: new Date().toISOString(),
      }).eq("id", id).select().single();
      if (error) throw error;

      await sb.from("hr_policy_audit").insert({
        policy_config_id: id, action: "activated", actor_email: actorEmail,
        prev_settings: current ? current.settings : null, new_settings: activated.settings,
        reason: "Policy activated",
      });

      return new Response(JSON.stringify({ success: true, data: activated }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_draft") {
      const { id } = body;
      const { error } = await sb.from("hr_policy_config").delete().eq("id", id).eq("status", "draft");
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "save_tab") {
      const { tab, sections } = body;
      let tabId;
      if (tab.id) {
        const { error } = await sb.from("hr_custom_tabs").update(tab).eq("id", tab.id);
        if (error) throw error;
        tabId = tab.id;
      } else {
        const { data: newTab, error } = await sb.from("hr_custom_tabs").insert([tab]).select().single();
        if (error) throw error;
        tabId = newTab.id;
      }
      await sb.from("hr_custom_tab_sections").delete().eq("tab_id", tabId);
      if (sections && sections.length > 0) {
        const secRows = sections.map((s: any, i: number) => ({
          tab_id: tabId, section_type: s.section_type, title: s.title || null,
          content: s.content || {}, sort_order: i, visible: s.visible !== false,
        }));
        const { error: secErr } = await sb.from("hr_custom_tab_sections").insert(secRows);
        if (secErr) throw secErr;
      }
      return new Response(JSON.stringify({ success: true, tab_id: tabId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_tab_status") {
      const { id, status, extra } = body;
      const update: any = { status, updated_at: new Date().toISOString(), ...extra };
      const { error } = await sb.from("hr_custom_tabs").update(update).eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action: " + action }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
