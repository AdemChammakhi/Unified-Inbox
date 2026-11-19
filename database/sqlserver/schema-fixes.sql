/*
  schema-fixes.sql — the fixes to the 5 Oct 2026 scripts' stored procedures
  (decision D16, asked for by the owner on 19 Nov 2026; open items 8 and 9).

  PROCEDURES ONLY: no table, column, constraint, index, view or function is
  touched, and the two scripts in schema/ stay the owner's files, verbatim. deploy.sh runs
  this file after them; it is idempotent (CREATE OR ALTER).

  GENERATED from the scripts' own procedure text with targeted replacements
  (see decisions.md D16 for the list) — to change a fix, change the script's
  procedure and regenerate, rather than editing this file by hand.

  UnifiedBoxDW
    usp_load_fact_call                    a call without a lead gets lead_key NULL, not -1
                                          (FK_fact_call_lead refused every call); an outbound
                                          call's agent is read from the source extension
    usp_load_fact_lead                    is_classified_flag = classified_date is set
    usp_load_fact_qualification_duration  refreshes entered_at and lead_key, deletes rows
                                          whose history is gone
    all three                             date keys by CONVERT(…, 112) instead of the FORMAT function
  UnifiedBox1
    usp_load_leads_from_staging           blank cells become "Nouveau lead" (both lists);
                                          telephone → call, messenger → facebook; rows with an
                                          unknown platform or an unreadable creation date are
                                          skipped and counted (leads_ignores); one contact per
                                          phone; an email is kept on one contact only
    usp_load_fact_call                    dropped here: it reads warehouse tables and could
                                          never run in this database
*/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
USE [UnifiedBoxDW]
GO
CREATE OR ALTER PROCEDURE [dbo].[usp_load_fact_call]
AS
BEGIN
    SET NOCOUNT ON;
 
    ;WITH staged AS (
        SELECT
            cl.call_log_id,
            fl.lead_key AS lead_key,
            CONVERT(int, CONVERT(char(8), cl.call_date, 112)) AS date_call_key,
            ISNULL(dch.channel_key, -1) AS channel_key,
            ISNULL(da_group.agent_key, ISNULL(da_direct.agent_key, -1)) AS agent_key,
            ISNULL(cl.ring_group, N'Sans groupe') AS ring_group,
            cl.direction,
            cl.call_status,
            cl.duration_seconds,
            cl.is_answered_flag
        FROM dbo.src_call_log cl
        CROSS APPLY (
            SELECT dst_ext = CASE
                                 WHEN cl.direction = N'outbound' AND cl.src_channel_ref LIKE N'SIP/%-%'
                                  THEN SUBSTRING(cl.src_channel_ref, 5, CHARINDEX(N'-', cl.src_channel_ref, 5) - 5)
                                 WHEN cl.direction <> N'outbound' AND cl.dst_channel_ref LIKE N'SIP/%-%'
                                  THEN SUBSTRING(cl.dst_channel_ref, 5, CHARINDEX(N'-', cl.dst_channel_ref, 5) - 5)
                             END
        ) x
        LEFT JOIN dbo.fact_lead fl ON fl.conversation_id = cl.conversation_id
        LEFT JOIN dbo.dim_channel dch ON dch.channel_id = cl.channel_id AND dch.is_current = 1
        LEFT JOIN dbo.src_extension_agents ea
            ON ea.extension_number = x.dst_ext
           AND UnifiedBox1.dbo.fn_DateTimeCombine(cl.call_date, cl.call_time)
                 >= UnifiedBox1.dbo.fn_DateTimeCombine(ea.valid_from_date, ea.valid_from_time)
           AND (ea.valid_to_date IS NULL
                OR UnifiedBox1.dbo.fn_DateTimeCombine(cl.call_date, cl.call_time)
                     < UnifiedBox1.dbo.fn_DateTimeCombine(ea.valid_to_date, ea.valid_to_time))
        LEFT JOIN dbo.dim_agent da_group ON da_group.user_id = ea.user_id AND da_group.is_current = 1
        LEFT JOIN dbo.src_channel_call_config ccc ON ccc.channel_id = cl.channel_id
        LEFT JOIN dbo.dim_agent da_direct ON da_direct.user_id = ccc.default_agent_user_id AND da_direct.is_current = 1
    )
    MERGE dbo.fact_call AS tgt
    USING staged AS src
    ON tgt.call_log_id = src.call_log_id
    WHEN MATCHED THEN
        UPDATE SET
            lead_key = src.lead_key, channel_key = src.channel_key, agent_key = src.agent_key,
            ring_group = src.ring_group, direction = src.direction, call_status = src.call_status,
            duration_seconds = src.duration_seconds, is_answered_flag = src.is_answered_flag,
            etl_loaded_at = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (call_log_id, lead_key, date_call_key, channel_key, agent_key, ring_group, direction, call_status, duration_seconds, is_answered_flag)
        VALUES (src.call_log_id, src.lead_key, src.date_call_key, src.channel_key, src.agent_key, src.ring_group, src.direction, src.call_status, src.duration_seconds, src.is_answered_flag);
END
GO
CREATE OR ALTER PROCEDURE [dbo].[usp_load_fact_lead]
AS
BEGIN
    SET NOCOUNT ON;

    ;WITH last_msg AS (
        SELECT conversation_id,
               max_sent_at = MAX(UnifiedBox1.dbo.fn_DateTimeCombine(sent_date, sent_time)),
               msg_count   = COUNT(*)
        FROM dbo.src_message
        GROUP BY conversation_id
    ),
    agent_replied AS (
        SELECT DISTINCT conversation_id FROM dbo.src_message WHERE sender_type = N'agent'
    ),
    call_answered AS (          -- FIX 3: a call lead is answered when one of its calls was ANSWERED
        SELECT DISTINCT conversation_id FROM dbo.src_call_log
        WHERE conversation_id IS NOT NULL AND is_answered_flag = 1
    ),
    staged AS (
        SELECT
            c.conversation_id,
            c.external_id                                                      AS conversation_external_id,
            CONVERT(int, CONVERT(char(8), c.created_date, 112))                     AS date_created_key,
            CASE WHEN c.classified_date IS NULL THEN NULL
                 ELSE CONVERT(int, CONVERT(char(8), c.classified_date, 112)) END    AS date_classified_key,
            CASE WHEN c.appointment_date IS NULL OR c.appointment_date = '1900-01-01' THEN NULL
                 ELSE CONVERT(int, CONVERT(char(8), c.appointment_date, 112)) END   AS date_appointment_key,
            CONVERT(int, CONVERT(char(8),
                CASE WHEN lm.max_sent_at IS NULL
                          THEN UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time)
                     WHEN lm.max_sent_at > UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time)
                          THEN lm.max_sent_at
                     ELSE UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time) END,
                112))                                             AS date_last_activity_key,
            ISNULL(dch.channel_key, -1)                                        AS channel_key,
            ISNULL(dca.campaign_key, -1)                                       AS campaign_key,
            ISNULL(dco.contact_key, -1)                                        AS contact_key,
            ISNULL(dag1.agent_key, -1)                                         AS assigned_agent_key,
            ISNULL(dag2.agent_key, -1)                                         AS classified_by_agent_key,
            ISNULL(ds.status_key, -1)                                          AS status_key,
            ISNULL(dcl.classification_key, -1)                                 AS classification_key,
            ISNULL(dq.qualification_key, -1)                                   AS qualification_key,
            ISNULL(dm.motif_key, -1)                                           AS motif_key,
            -- FIX 4: imported leads have no message rows -> keep the count coming from the import
            CASE WHEN ISNULL(lm.msg_count, 0) >= c.message_count THEN ISNULL(lm.msg_count, 0)
                 ELSE c.message_count END                                      AS message_count,
            c.unread_count                                                     AS unread_count,
            1 - f2.is_ans                                                      AS is_unanswered_flag,
            f2.is_ans                                                          AS is_answered_flag,
            f1.is_class                                                        AS is_classified_flag,
            CASE WHEN c.appointment_date IS NOT NULL AND c.appointment_date <> '1900-01-01' THEN 1 ELSE 0 END AS is_appointment_flag,
            CASE WHEN dq.qualification_group = N'Gagné' THEN 1 ELSE 0 END      AS is_won_flag,
            CASE WHEN c.deleted_date IS NOT NULL THEN 1 ELSE 0 END             AS deleted_flag
        FROM dbo.src_conversations c
        LEFT JOIN last_msg lm        ON lm.conversation_id = c.conversation_id
        LEFT JOIN agent_replied ar   ON ar.conversation_id = c.conversation_id
        LEFT JOIN call_answered ca   ON ca.conversation_id = c.conversation_id
        LEFT JOIN dbo.dim_channel dch ON dch.channel_id = c.channel_id AND dch.is_current = 1
        LEFT JOIN dbo.dim_campaign dca ON dca.campaign_id = c.campaign_id
        LEFT JOIN dbo.dim_contact dco ON dco.contact_id = c.contact_id AND dco.is_current = 1
        LEFT JOIN dbo.dim_agent dag1 ON dag1.user_id = c.assigned_to_user_id AND dag1.is_current = 1
        LEFT JOIN dbo.dim_agent dag2 ON dag2.user_id = c.classified_by_user_id AND dag2.is_current = 1
        LEFT JOIN dbo.dim_status ds ON ds.status_code = c.status
        LEFT JOIN dbo.dim_classification dcl ON dcl.classification_key = c.classification_id
        LEFT JOIN dbo.dim_qualification dq ON dq.qualification_key = c.qualification_id
        LEFT JOIN dbo.dim_motif_contact dm ON dm.motif_key = c.motif_id
        -- classified = the dossier was worked (classified_date), decisions.md D16
        CROSS APPLY (SELECT is_class = CASE WHEN c.classified_date IS NOT NULL THEN 1 ELSE 0 END) f1
        -- FIX 3/4: answered = agent message OR answered call OR (imported, no messages, already classified)
        CROSS APPLY (SELECT is_ans = CASE WHEN ar.conversation_id IS NOT NULL
                                            OR ca.conversation_id IS NOT NULL
                                            OR (c.external_id LIKE N'IMPORT-%'
                                                AND lm.conversation_id IS NULL
                                                AND f1.is_class = 1)
                                          THEN 1 ELSE 0 END) f2
    )
    MERGE dbo.fact_lead AS tgt
    USING staged AS src
    ON tgt.conversation_id = src.conversation_id
    WHEN MATCHED THEN
        UPDATE SET
            date_classified_key = src.date_classified_key,
            date_appointment_key = src.date_appointment_key,
            date_last_activity_key = src.date_last_activity_key,
            channel_key = src.channel_key,
            campaign_key = src.campaign_key,
            contact_key = src.contact_key,
            assigned_agent_key = src.assigned_agent_key,
            classified_by_agent_key = src.classified_by_agent_key,
            status_key = src.status_key,
            classification_key = src.classification_key,
            qualification_key = src.qualification_key,
            motif_key = src.motif_key,
            message_count = src.message_count,
            unread_count = src.unread_count,
            is_unanswered_flag = src.is_unanswered_flag,
            is_answered_flag = src.is_answered_flag,
            is_classified_flag = src.is_classified_flag,
            is_appointment_flag = src.is_appointment_flag,
            is_won_flag = src.is_won_flag,
            deleted_flag = src.deleted_flag,
            etl_loaded_at = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (conversation_id, conversation_external_id, date_created_key, date_classified_key, date_appointment_key,
                date_last_activity_key, channel_key, campaign_key, contact_key, assigned_agent_key, classified_by_agent_key,
                status_key, classification_key, qualification_key, motif_key, message_count, unread_count,
                is_unanswered_flag, is_answered_flag, is_classified_flag, is_appointment_flag, is_won_flag, deleted_flag)
        VALUES (src.conversation_id, src.conversation_external_id, src.date_created_key, src.date_classified_key, src.date_appointment_key,
                src.date_last_activity_key, src.channel_key, src.campaign_key, src.contact_key, src.assigned_agent_key, src.classified_by_agent_key,
                src.status_key, src.classification_key, src.qualification_key, src.motif_key, src.message_count, src.unread_count,
                src.is_unanswered_flag, src.is_answered_flag, src.is_classified_flag, src.is_appointment_flag, src.is_won_flag, src.deleted_flag);
END
GO
CREATE OR ALTER PROCEDURE [dbo].[usp_load_fact_qualification_duration]
AS
BEGIN
    SET NOCOUNT ON;

    ;WITH base AS (
        SELECT
            h.conversation_id,
            h.qualification_id,
            h.changed_by_user_id,
            changed_at = UnifiedBox1.dbo.fn_DateTimeCombine(h.changed_date, h.changed_time)
        FROM dbo.src_conversation_qualification_history h
    ),
    ordered AS (
        SELECT
            conversation_id, qualification_id, changed_by_user_id, changed_at,
            sequence_number = ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY changed_at),
            next_changed_at = LEAD(changed_at) OVER (PARTITION BY conversation_id ORDER BY changed_at)
        FROM base
    ),
    staged AS (
        SELECT
            fl.lead_key,
            o.conversation_id,
            o.qualification_id,
            ISNULL(da.agent_key, -1) AS agent_key,
            o.sequence_number,
            o.changed_at AS entered_at,
            o.next_changed_at AS exited_at,
            CASE WHEN o.next_changed_at IS NULL THEN NULL
                 ELSE CAST(DATEDIFF(MINUTE, o.changed_at, o.next_changed_at) / 60.0 AS DECIMAL(10,2)) END AS duration_hours,
            CASE WHEN o.next_changed_at IS NULL THEN 1 ELSE 0 END AS is_ongoing_flag
        FROM ordered o
        INNER JOIN dbo.fact_lead fl ON fl.conversation_id = o.conversation_id
        LEFT JOIN dbo.dim_agent da ON da.user_id = o.changed_by_user_id AND da.is_current = 1
    )
    MERGE dbo.fact_qualification_duration AS tgt
    USING staged AS src
    ON tgt.conversation_id = src.conversation_id AND tgt.sequence_number = src.sequence_number
    WHEN MATCHED THEN
        UPDATE SET
            lead_key = src.lead_key,
            qualification_key = src.qualification_id,
            agent_key = src.agent_key,
            entered_at = src.entered_at,
            exited_at = src.exited_at,
            duration_hours = src.duration_hours,
            is_ongoing_flag = src.is_ongoing_flag
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (lead_key, conversation_id, qualification_key, agent_key, sequence_number, entered_at, exited_at, duration_hours, is_ongoing_flag)
        VALUES (src.lead_key, src.conversation_id, src.qualification_id, src.agent_key, src.sequence_number, src.entered_at, src.exited_at, src.duration_hours, src.is_ongoing_flag)
    WHEN NOT MATCHED BY SOURCE THEN
        DELETE;
END
GO
USE [UnifiedBox1]
GO
CREATE OR ALTER PROCEDURE [dbo].[usp_load_leads_from_staging]
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRANSACTION;

    BEGIN TRY

        IF OBJECT_ID('tempdb..#leads') IS NOT NULL DROP TABLE #leads;

        SELECT
            platform             = CASE LOWER(LTRIM(RTRIM(platform_raw)))
                                       WHEN N'telephone' THEN N'call' WHEN N'téléphone' THEN N'call'
                                       WHEN N'messenger' THEN N'facebook'
                                       ELSE LOWER(LTRIM(RTRIM(platform_raw))) END,
            channel_label        = NULLIF(LTRIM(RTRIM(channel_label_raw)), ''),
            participant_name     = NULLIF(LTRIM(RTRIM(participant_name)), 'Unknown'),
            phone                = NULLIF(LTRIM(RTRIM(phone_raw)), ''),
            email                = NULLIF(LTRIM(RTRIM(email_raw)), ''),
            first_contact_at     = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(created_at_raw)), 103),
            last_contact_at      = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(updated_at_raw)), 103),
            classification_label = ISNULL(NULLIF(LTRIM(RTRIM(classification_raw)), ''), N'Nouveau lead'),
            -- FIX 5: blank qualification = initial state instead of NULL (column is NOT NULL)
            qualification_label  = ISNULL(NULLIF(LTRIM(RTRIM(qualification_raw)), ''), N'Nouveau lead'),
            motif_label          = NULLIF(LTRIM(RTRIM(motif_raw)), ''),
            rdv_le               = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(rdv_le_raw)), 103),
            assigned_agent_label = NULLIF(LTRIM(RTRIM(assigned_agent_raw)), ''),
            message_count        = TRY_CONVERT(int, message_count_raw),
            unread_count         = TRY_CONVERT(int, unread_count_raw),
            last_message         = last_message_raw
        INTO #leads
        FROM stg.leads_import;
        DECLARE @ignored int;
        DELETE FROM #leads
        WHERE platform IS NULL
           OR platform NOT IN (N'facebook', N'instagram', N'whatsapp', N'tiktok', N'email', N'call')
           OR first_contact_at IS NULL;
        SET @ignored = @@ROWCOUNT;
        UPDATE #leads SET last_contact_at = first_contact_at WHERE last_contact_at IS NULL;
        -- one name and one email per person (a phone, else a name) …
        ;WITH p AS (
            SELECT participant_name, email,
                   keep_name = FIRST_VALUE(participant_name) OVER (PARTITION BY phone ORDER BY first_contact_at),
                   keep_email = FIRST_VALUE(email) OVER (PARTITION BY phone ORDER BY CASE WHEN email IS NULL THEN 1 ELSE 0 END, first_contact_at)
            FROM #leads WHERE phone IS NOT NULL
        )
        UPDATE p SET participant_name = keep_name, email = keep_email;
        ;WITH p AS (
            SELECT email,
                   keep_email = FIRST_VALUE(email) OVER (PARTITION BY participant_name ORDER BY CASE WHEN email IS NULL THEN 1 ELSE 0 END, first_contact_at)
            FROM #leads WHERE phone IS NULL AND participant_name IS NOT NULL
        )
        UPDATE p SET email = keep_email;
        -- … and an email on one person only: the first in the file, never one
        -- a contact of the database already holds
        ;WITH e AS (
            SELECT email, person = ISNULL(phone, N'name:' + ISNULL(participant_name, N'')),
                   first_person = FIRST_VALUE(ISNULL(phone, N'name:' + ISNULL(participant_name, N''))) OVER (PARTITION BY email ORDER BY first_contact_at)
            FROM #leads WHERE email IS NOT NULL
        )
        UPDATE e SET email = NULL WHERE person <> first_person;
        UPDATE l SET email = NULL
        FROM #leads l
        WHERE l.email IS NOT NULL
          AND EXISTS (SELECT 1 FROM dbo.contacts c
                      WHERE c.email = l.email
                        AND NOT (c.phone = l.phone OR (c.phone IS NULL AND l.phone IS NULL AND c.display_name = l.participant_name)));

        INSERT INTO dbo.classifications (label, sort_order)
        SELECT DISTINCT l.classification_label, 99
        FROM #leads l
        WHERE NOT EXISTS (SELECT 1 FROM dbo.classifications c WHERE c.label = l.classification_label);

        INSERT INTO dbo.qualifications (label, qualification_group, is_terminal, sort_order)
        SELECT DISTINCT l.qualification_label, 'Nouveau', 0, 99
        FROM #leads l
        WHERE l.qualification_label IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.qualifications q WHERE q.label = l.qualification_label);

        IF NOT EXISTS (SELECT 1 FROM dbo.motifs_contact WHERE label = N'Non spécifié')
            INSERT INTO dbo.motifs_contact (label, sort_order) VALUES (N'Non spécifié', 0);

        INSERT INTO dbo.motifs_contact (label, sort_order)
        SELECT DISTINCT l.motif_label, 99
        FROM #leads l
        WHERE l.motif_label IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.motifs_contact m WHERE m.label = l.motif_label);

        INSERT INTO dbo.channels (platform, name, external_id, is_active, is_verified, auto_reply, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT l.platform, l.platform, 'IMPORT-' + l.platform, 1, 0, 0,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #leads l
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.channels c
            WHERE c.platform = l.platform AND c.external_id = 'IMPORT-' + l.platform
        );

        IF OBJECT_ID('tempdb..#resolved') IS NOT NULL DROP TABLE #resolved;

        SELECT
            l.*,
            channel_id          = ch.channel_id,
            classification_id   = cl.classification_id,
            qualification_id    = qu.qualification_id,
            motif_id            = ISNULL(mo.motif_id, mo_default.motif_id),
            assigned_to_user_id = (
                SELECT TOP 1 u.user_id
                FROM dbo.users u
                WHERE l.assigned_agent_label IS NOT NULL
                  AND LOWER(u.first_name + ' ' + u.last_name) = LOWER(l.assigned_agent_label)
            )
        INTO #resolved
        FROM #leads l
        JOIN dbo.channels ch
            ON ch.platform = l.platform AND ch.external_id = 'IMPORT-' + l.platform
        JOIN dbo.classifications cl
            ON cl.label = l.classification_label
        LEFT JOIN dbo.qualifications qu
            ON qu.label = l.qualification_label
        LEFT JOIN dbo.motifs_contact mo
            ON mo.label = l.motif_label
        CROSS JOIN (
            SELECT motif_id FROM dbo.motifs_contact WHERE label = N'Non spécifié'
        ) mo_default;

        INSERT INTO dbo.contacts (display_name, phone, email, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT r.participant_name, r.phone, r.email,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #resolved r
        WHERE r.phone IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.contacts c WHERE c.phone = r.phone);

        INSERT INTO dbo.contacts (display_name, email, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT r.participant_name, r.email,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #resolved r
        WHERE r.phone IS NULL
          AND r.participant_name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.contacts c WHERE c.display_name = r.participant_name AND c.phone IS NULL);

        ALTER TABLE #resolved ADD contact_id uniqueidentifier NULL;

        UPDATE r
        SET r.contact_id = c.contact_id
        FROM #resolved r
        JOIN dbo.contacts c ON c.phone = r.phone
        WHERE r.phone IS NOT NULL;

        UPDATE r
        SET r.contact_id = c.contact_id
        FROM #resolved r
        JOIN dbo.contacts c ON c.display_name = r.participant_name AND c.phone IS NULL
        WHERE r.phone IS NULL AND r.contact_id IS NULL;

        INSERT INTO dbo.classification_qualification_matrix (classification_id, qualification_id)
        SELECT DISTINCT r.classification_id, r.qualification_id
        FROM #resolved r
        WHERE r.qualification_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM dbo.classification_qualification_matrix m
              WHERE m.classification_id = r.classification_id
                AND m.qualification_id = r.qualification_id
          );

        MERGE dbo.conversations AS tgt
        USING (
            SELECT * FROM #resolved WHERE contact_id IS NOT NULL
        ) AS src
        ON tgt.channel_id = src.channel_id
           AND tgt.contact_id = src.contact_id
           AND tgt.participant_name = src.participant_name
           AND tgt.created_date = CONVERT(date, src.first_contact_at)
           AND tgt.created_time = CONVERT(time(0), src.first_contact_at)
        WHEN MATCHED THEN
            UPDATE SET
                tgt.updated_date = CONVERT(date, src.last_contact_at),
                tgt.updated_time = CONVERT(time(0), src.last_contact_at),
                tgt.classification_id = src.classification_id,
                tgt.qualification_id = src.qualification_id,
                tgt.motif_id = src.motif_id,
                tgt.assigned_to_user_id = src.assigned_to_user_id,
                tgt.appointment_date = CONVERT(date, src.rdv_le),
                tgt.appointment_time = CONVERT(time(0), src.rdv_le),
                tgt.message_count = ISNULL(src.message_count, tgt.message_count),
                tgt.unread_count = ISNULL(src.unread_count, tgt.unread_count),
                -- FIX 4: keep/derive a classification date (best estimate = last contact)
                tgt.classified_date = CASE WHEN src.classification_label <> N'Nouveau lead'
                                           THEN ISNULL(tgt.classified_date, CONVERT(date, src.last_contact_at))
                                           ELSE tgt.classified_date END,
                tgt.classified_time = CASE WHEN src.classification_label <> N'Nouveau lead'
                                           THEN ISNULL(tgt.classified_time, CONVERT(time(0), src.last_contact_at))
                                           ELSE tgt.classified_time END
        WHEN NOT MATCHED THEN
            INSERT (
                platform, external_id, channel_id, contact_id, participant_name,
                status, classification_id, qualification_id, motif_id,
                assigned_to_user_id, appointment_date, appointment_time, message_count, unread_count,
                classified_date, classified_time,
                created_date, created_time, updated_date, updated_time
            )
            VALUES (
                src.platform,
                CONCAT('IMPORT-', src.platform, '-', CONVERT(nvarchar(36), NEWID())),
                src.channel_id, src.contact_id, src.participant_name,
                'open', src.classification_id, src.qualification_id, src.motif_id,
                src.assigned_to_user_id,
                CONVERT(date, src.rdv_le), CONVERT(time(0), src.rdv_le),
                ISNULL(src.message_count, 0), ISNULL(src.unread_count, 0),
                CASE WHEN src.classification_label <> N'Nouveau lead' THEN CONVERT(date, src.last_contact_at) END,
                CASE WHEN src.classification_label <> N'Nouveau lead' THEN CONVERT(time(0), src.last_contact_at) END,
                CONVERT(date, src.first_contact_at), CONVERT(time(0), src.first_contact_at),
                CONVERT(date, src.last_contact_at), CONVERT(time(0), src.last_contact_at)
            );

        -- FIX 4: qualification history for imported leads (only the state we actually know:
        -- current qualification, dated at last contact). Re-runs only add a row when it changed.
        INSERT INTO dbo.conversation_qualification_history
               (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
        SELECT c.conversation_id, c.qualification_id, c.assigned_to_user_id, c.updated_date, c.updated_time
        FROM dbo.conversations c
        OUTER APPLY (
            SELECT TOP 1 h.qualification_id
            FROM dbo.conversation_qualification_history h
            WHERE h.conversation_id = c.conversation_id
            ORDER BY h.changed_date DESC, h.changed_time DESC, h.history_id DESC
        ) lh
        WHERE c.external_id LIKE N'IMPORT-%'
          AND (lh.qualification_id IS NULL OR lh.qualification_id <> c.qualification_id);

        COMMIT TRANSACTION;

        SELECT
            leads_in_staging = (SELECT COUNT(*) FROM stg.leads_import),
            leads_ignores = @ignored,
            leads_sans_contact_resolu = (SELECT COUNT(*) FROM #resolved WHERE contact_id IS NULL);

    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO
IF OBJECT_ID(N'dbo.usp_load_fact_call', N'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_load_fact_call;
GO
