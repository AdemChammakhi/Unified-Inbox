/**
 * reference.js — the rows UnifiedBox1's lookup tables need, and the maps between
 * the app's codes and their ids.
 *
 * - classifications: the 7 "Étapes" (constants/pipeline.js ETAPES), the only
 *   labels CK_classifications_label allows.
 * - qualifications: the 10 "Qualifications" (QUALIFICATIONS), the only labels
 *   CK_qualifications_label allows, with the group the warehouse reads
 *   ("Gagné" = won) and the terminal flag.
 *   A pipeline stage is stored as one (Étape, Qualification) pair
 *   (STAGE_TO_PAIR, decision D10); the pair ids are mapped here.
 * - motifs_contact: the typologies, plus "Non spécifié" for a lead whose
 *   typologie is not known yet (conversations.motif_id is NOT NULL) — the
 *   label the scripts' own lead import uses, so both share one row. A
 *   typologie whose label management renamed keeps its row: the row is
 *   found under its previous label and renamed (rows only, never schema).
 *
 * Missing rows are inserted, matched by label; existing rows keep their ids.
 * The order, group and terminal flag of the app's labels are set again on
 * every start and before each warehouse load: the lead import
 * (usp_load_leads_from_staging) inserts the labels it meets as "Nouveau",
 * and a "Départ" stored that way would never count as won. The tables have
 * no code column, so the app keeps the code ↔ label mapping.
 */

"use strict";

const { tx } = require("./sql");
const {
  ETAPES,
  QUALIFICATIONS,
  STAGES,
  STAGE_TO_PAIR,
  stageOfPair,
  TYPOLOGIES,
  DEFAULT_STAGE,
} = require("../constants/pipeline");

const NO_TYPOLOGY_LABEL = "Non spécifié";

let _refs = null;

/** Insert the missing lookup rows, align the app's ones, then load the maps. Idempotent. */
async function ensureReferenceRows() {
  const loaded = await tx(async (t) => {
    // Funnel steps first, in order, so "Nouveau lead" is row 1 of a new database
    for (const e of ETAPES) {
      await t.query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.classifications WHERE label = @label)
         BEGIN
           INSERT dbo.classifications (label, sort_order) VALUES (@label, @sort);
         END
         ELSE
         BEGIN
           UPDATE dbo.classifications SET sort_order = @sort WHERE label = @label AND sort_order <> @sort;
         END`,
        { label: e.label, sort: e.ordinal },
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
    const motifs = [{ label: NO_TYPOLOGY_LABEL }, ...TYPOLOGIES];
    for (let i = 0; i < motifs.length; i += 1) {
      const m = motifs[i];
      // A renamed typologie keeps its row (and the conversations pointing at it)
      for (const previous of m.previousLabels || []) {
        await t.query(
          `IF NOT EXISTS (SELECT 1 FROM dbo.motifs_contact WHERE label = @label)
             UPDATE dbo.motifs_contact SET label = @label WHERE label = @previous;`,
          { label: m.label, previous },
        );
      }
      await t.query(
        `IF NOT EXISTS (SELECT 1 FROM dbo.motifs_contact WHERE label = @label)
           INSERT dbo.motifs_contact (label, sort_order) VALUES (@label, @sort);`,
        { label: m.label, sort: i },
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

  const etapeToId = {};
  const idToEtape = {};
  for (const e of ETAPES) {
    const id = classificationIds.get(e.label);
    etapeToId[e.key] = id;
    idToEtape[id] = e.key;
  }
  const qualificationToId = {};
  const idToQualification = {};
  for (const q of QUALIFICATIONS) {
    const id = qualificationIds.get(q.label);
    qualificationToId[q.key] = id;
    idToQualification[id] = q.key;
  }
  // stage → { classificationId, qualificationId }
  const stageToPairIds = {};
  for (const s of STAGES) {
    const [e, q] = STAGE_TO_PAIR[s.key];
    stageToPairIds[s.key] = { classificationId: etapeToId[e], qualificationId: qualificationToId[q] };
  }
  const typologyToMotif = { "": motifIds.get(NO_TYPOLOGY_LABEL) };
  const motifToTypology = { [motifIds.get(NO_TYPOLOGY_LABEL)]: "" };
  for (const typology of TYPOLOGIES) {
    const id = motifIds.get(typology.label);
    typologyToMotif[typology.key] = id;
    motifToTypology[id] = typology.key;
  }

  _refs = {
    etapeToId,
    idToEtape,
    qualificationToId,
    idToQualification,
    stageToPairIds,
    typologyToMotif,
    motifToTypology,
    defaults: {
      ...stageToPairIds[DEFAULT_STAGE],
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

/** The stage a row's (classification_id, qualification_id) means. */
const stageOf = (classificationId, qualificationId) => {
  const r = refs();
  const e = r.idToEtape[classificationId];
  const q = r.idToQualification[qualificationId];
  if (!e || !q) return DEFAULT_STAGE;
  return stageOfPair(e, q);
};
/** The two ids a stage is stored as. */
const pairOf = (stage) => refs().stageToPairIds[stage] || refs().stageToPairIds[DEFAULT_STAGE];
const typologyOf = (motifId) => refs().motifToTypology[motifId] ?? "";

module.exports = {
  ensureReferenceRows,
  refs,
  stageOf,
  pairOf,
  typologyOf,
  NO_TYPOLOGY_LABEL,
};
