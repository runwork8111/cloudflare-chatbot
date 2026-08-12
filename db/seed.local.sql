-- Local dev-only seed data. Never run against --remote.
-- Raw API key for this seed is "dev-test-key" (see README for how to
-- regenerate the hash for a different key).

INSERT INTO tenants (id, slug, name, plan, model, system_prompt)
VALUES ('tenant_dev_1', 'acme', 'Acme Co', 'trial', 'gpt-4o-mini', 'You are Acme Co''s support assistant.');

INSERT INTO api_keys (id, tenant_id, key_hash, label)
VALUES ('key_dev_1', 'tenant_dev_1', '9b19acfa7e184a0451515a7fa702e451de423af0a785ff4a3d1e36f882dc80a9', 'local dev key');
