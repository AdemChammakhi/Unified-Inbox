/**
 * reference.js — the rows UnifiedBox1's lookup tables need, and the maps between
 * the app's codes and their ids.
 *
 * - classifications: the 7 funnel steps (constants/pipeline.js STAGES), the
 *   only labels CK_classifications_label allows. "Nouveau lead" is the step
 *   of every new conversation.
 * - qualifications: the 10 statuses (QUALIFICATIONS), the only labels
 *   CK_qualifications_label allows, with the group the warehouse reads
 *   ("Gagné" = won) and the terminal flag.
 * - motifs_contact: the typologies, plus "Non spécifié" for a lead whose
 *   typologie is not known yet (conversations.motif_id is NOT NULL) — the
 *   label the scripts' own lead import uses, so both share one row.
 *
 * Missing rows are inserted, matched by label; existing rows keep their ids.
 * The order, group and terminal flag of the app's labels are set again on
 * every start: the lead import (usp_load_leads_from_staging) inserts the labels
 * it meets as "Nouveau", and a confirmed dossier stored that way would never
 * count as won. The tables have no code column, so the app keeps the
 * code ↔ label mapping.
 */

"use strict";

const { tx } = require("./sql");
const {
  STAGES,
  QUALIFICATIONS,
  TYPOLOGIES,
  DEFAULT_STAGE,
  DEFAULT_QUALIFICATION,
} = require("../constants/pipeline");

const NO_TYPOLOGY_LABEL = "Non spécifié";

let _refs = null;

/** Insert the missing lookup rows, align the app's ones, then load the maps. Idempotent. */
async function ensureReferenceRows() {
  const loaded = await tx(async (t) => {
    // Funnel steps first, in order, so "Nouveau lead" is row 1 of a new database
    for (const stage of STAGES) {
      await t.query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.classifications WHERE label = @label)
         BEGIN
           INSERT dbo.classifications (label, sort_order) VALUES (@label, @sort);
         END
         ELSE
         BEGIN
           UPDATE dbo.classifications SET sort_order = @sort WHERE label = @label AND sort_order <> @sort;
         END`,
        { label: stage.label, sort: stage.ordinal },
      );
    }
    for (const q of QUALIFICATIONS) {
      await t.query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.qualifications WHERE label = @label)
         BEGIN
           INSERT dbo.qualifications (label, qualification_group, is_terminal, sort_order)
           VALUES (@label, @grp, @terminal, @sort);
         END
         ELSE
         BEGIN
           UPDATE dbo.qualifications
              SET qualification_group = @grp, is_terminal = @terminal, sort_order = @sort
            WHERE label = @label
              AND (qualification_group <> @grp OR is_terminal <> @terminal OR sort_order <> @sort);
         END`,
        { label: q.label, grp: q.group, terminal: q.terminal, sort: q.ordinal },
      );
    }
    const motifs = [NO_TYPOLOGY_LABEL, ...TYPOLOGIES.map((t) => t.label)];
    for (let i = 0; i < motifs.length; i += 1) {
      await t.query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.motifs_contact WHERE label = @label)
           INSERT dbo.motifs_contact (label, sort_order) VALUES (@label, @sort);`,
        { label: motifs[i], sort: i },
      );
    }
    return {
      classifications: (await t.query("SELECT classification_id AS id, label FROM dbo.classifications")).rows,
      qualifications: (await t.query("SELECT qualification_id AS id, label FROM dbo.qualifications")).rows,
      motifs: (await t.query("SELECT motif_id AS id, label FROM dbo.motifs_contact")).rows,
    };
  });

  const byLabel = (rows) => new Map(rows.map((r) => [r.label, r.id]));
  const classificationIds = byLabel(loaded.classifications);
  const qualificationIds = byLabel(loaded.qualifications);
  const motifIds = byLabel(loaded.motifs);

  const stageToClassification = {};
  const classificationToStage = {};
  for (const stage of STAGES) {
    const id = classificationIds.get(stage.label);
    stageToClassification[stage.key] = id;
    classificationToStage[id] = stage.key;
  }
  const qualificationToId = {};
  const idToQualification = {};
  for (const q of QUALIFICATIONS) {
    const id = qualificationIds.get(q.label);
    qualificationToId[q.key] = id;
    idToQualification[id] = q.key;
  }
  const typologyToMotif = { "": motifIds.get(NO_TYPOLOGY_LABEL) };
  const motifToTypology = { [motifIds.get(NO_TYPOLOGY_LABEL)]: "" };
  for (const typology of TYPOLOGIES) {
    const id = motifIds.get(typology.label);
    typologyToMotif[typology.key] = id;
    motifToTypology[id] = typology.key;
  }

  _refs = {
    stageToClassification,
    classificationToStage,
    qualificationToId,
    idToQualification,
    typologyToMotif,
    motifToTypology,
    defaults: {
      classificationId: stageToClassification[DEFAULT_STAGE],
      qualificationId: qualificationToId[DEFAULT_QUALIFICATION],
      motifId: motifIds.get(NO_TYPOLOGY_LABEL),
    },
  };
  return _refs;
}

/** The loaded maps. ensureReferenceRows() must have completed first. */
function refs() {
  if (!_refs) throw new Error("Reference rows not loaded yet (ensureReferenceRows)");
  return _refs;
}

const stageOf = (classificationId) => refs().classificationToStage[classificationId] || DEFAULT_STAGE;
const qualificationOf = (qualificationId) => refs().idToQualification[qualificationId] || DEFAULT_QUALIFICATION;
const typologyOf = (motifId) => refs().motifToTypology[motifId] ?? "";

module.exports = {
  ensureReferenceRows,
  refs,
  stageOf,
  qualificationOf,
  typologyOf,
  NO_TYPOLOGY_LABEL,
};
