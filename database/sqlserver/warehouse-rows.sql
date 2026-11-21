-- The rows the warehouse procedures expect and no script creates: the
-- "unknown" member -1 of every dimension the facts fall back on, and the
-- conversation statuses. Rows only, never schema (decision D5). Idempotent.
--
-- The same statements run in the backend at startup (server/db/warehouse.js,
-- ensureWarehouseRows): keep the two in step. Running them here, as sa,
-- means the app's login never needs the ALTER permission IDENTITY_INSERT asks.
USE [UnifiedBoxDW];
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.dim_agent WHERE agent_key = -1)
BEGIN
  SET IDENTITY_INSERT dbo.dim_agent ON;
  INSERT dbo.dim_agent (agent_key, user_id, full_name, role, is_active, effective_date, expiry_date, is_current)
  VALUES (-1, NULL, N'Non attribué', NULL, 0, '19000101', NULL, 1);
  SET IDENTITY_INSERT dbo.dim_agent OFF;
END
IF NOT EXISTS (SELECT 1 FROM dbo.dim_channel WHERE channel_key = -1)
BEGIN
  SET IDENTITY_INSERT dbo.dim_channel ON;
  INSERT dbo.dim_channel (channel_key, channel_id, platform, channel_name, external_id, is_active, is_verified, auto_reply, effective_date, expiry_date, is_current)
  VALUES (-1, NULL, N'inconnu', N'Canal inconnu', NULL, 0, 0, 0, '19000101', NULL, 1);
  SET IDENTITY_INSERT dbo.dim_channel OFF;
END
IF NOT EXISTS (SELECT 1 FROM dbo.dim_campaign WHERE campaign_key = -1)
BEGIN
  SET IDENTITY_INSERT dbo.dim_campaign ON;
  INSERT dbo.dim_campaign (campaign_key, campaign_id, platform, title, content_preview, permalink, date_diffusion, status)
  VALUES (-1, NULL, NULL, N'Sans campagne', NULL, NULL, NULL, NULL);
  SET IDENTITY_INSERT dbo.dim_campaign OFF;
END
IF NOT EXISTS (SELECT 1 FROM dbo.dim_contact WHERE contact_key = -1)
BEGIN
  SET IDENTITY_INSERT dbo.dim_contact ON;
  INSERT dbo.dim_contact (contact_key, contact_id, display_name, email, phone, company_name, job_title, is_vip, is_blocked, is_spam, effective_date, expiry_date, is_current)
  VALUES (-1, NULL, N'Contact inconnu', NULL, NULL, NULL, NULL, 0, 0, 0, '19000101', NULL, 1);
  SET IDENTITY_INSERT dbo.dim_contact OFF;
END
IF NOT EXISTS (SELECT 1 FROM dbo.dim_classification WHERE classification_key = -1)
  INSERT dbo.dim_classification (classification_key, classification_label_fr, sort_order) VALUES (-1, N'Inconnue', 255);
IF NOT EXISTS (SELECT 1 FROM dbo.dim_qualification WHERE qualification_key = -1)
  INSERT dbo.dim_qualification (qualification_key, qualification_label, qualification_group, is_terminal) VALUES (-1, N'Inconnue', N'Nouveau', 0);
IF NOT EXISTS (SELECT 1 FROM dbo.dim_motif_contact WHERE motif_key = -1)
  INSERT dbo.dim_motif_contact (motif_key, motif_label_fr) VALUES (-1, N'Inconnu');
IF NOT EXISTS (SELECT 1 FROM dbo.dim_status WHERE status_key = -1)
  INSERT dbo.dim_status (status_key, status_code, status_label_fr) VALUES (-1, N'unknown', N'Inconnu');

INSERT dbo.dim_status (status_key, status_code, status_label_fr)
SELECT (SELECT ISNULL(MAX(status_key), 0) FROM dbo.dim_status WHERE status_key > 0) + ROW_NUMBER() OVER (ORDER BY v.ord),
       v.code, v.label
FROM (VALUES (1, N'open', N'Ouvert'), (2, N'pending', N'En attente'), (3, N'resolved', N'Résolu'))
     AS v (ord, code, label)
WHERE NOT EXISTS (SELECT 1 FROM dbo.dim_status s WHERE s.status_code = v.code);
GO
