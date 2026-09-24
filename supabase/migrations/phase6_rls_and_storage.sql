-- Phase 5: Storage bucket for custom tab documents
INSERT INTO storage.buckets (id, name, public) VALUES ('custom-tab-docs', 'custom-tab-docs', true)
ON CONFLICT (id) DO NOTHING;

-- Phase 6: RLS on hr_policy_config
ALTER TABLE hr_policy_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read active policies" ON hr_policy_config FOR SELECT USING (true);
CREATE POLICY "No direct inserts on policy config" ON hr_policy_config FOR INSERT WITH CHECK (false);
CREATE POLICY "No direct updates on policy config" ON hr_policy_config FOR UPDATE USING (false);
CREATE POLICY "No direct deletes on policy config" ON hr_policy_config FOR DELETE USING (false);

-- RLS on hr_policy_audit
ALTER TABLE hr_policy_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read policy audit" ON hr_policy_audit FOR SELECT USING (true);
CREATE POLICY "No direct writes on policy audit" ON hr_policy_audit FOR INSERT WITH CHECK (false);

-- RLS on hr_custom_tabs
ALTER TABLE hr_custom_tabs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read tabs" ON hr_custom_tabs FOR SELECT USING (true);
CREATE POLICY "No direct inserts on tabs" ON hr_custom_tabs FOR INSERT WITH CHECK (false);
CREATE POLICY "No direct updates on tabs" ON hr_custom_tabs FOR UPDATE USING (false);
CREATE POLICY "No direct deletes on tabs" ON hr_custom_tabs FOR DELETE USING (false);

-- RLS on hr_custom_tab_sections
ALTER TABLE hr_custom_tab_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read sections" ON hr_custom_tab_sections FOR SELECT USING (true);
CREATE POLICY "No direct inserts on sections" ON hr_custom_tab_sections FOR INSERT WITH CHECK (false);
CREATE POLICY "No direct updates on sections" ON hr_custom_tab_sections FOR UPDATE USING (false);
CREATE POLICY "No direct deletes on sections" ON hr_custom_tab_sections FOR DELETE USING (false);

-- RLS on hr_custom_tab_submissions — employees can read and insert
ALTER TABLE hr_custom_tab_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read submissions" ON hr_custom_tab_submissions FOR SELECT USING (true);
CREATE POLICY "Anyone can submit" ON hr_custom_tab_submissions FOR INSERT WITH CHECK (true);

-- RLS on hr_custom_tab_permissions
ALTER TABLE hr_custom_tab_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read permissions" ON hr_custom_tab_permissions FOR SELECT USING (true);
CREATE POLICY "No direct writes on permissions" ON hr_custom_tab_permissions FOR INSERT WITH CHECK (false);
