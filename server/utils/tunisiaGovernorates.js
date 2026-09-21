/**
 * tunisiaGovernorates.js — city → gouvernorat for the partners directory.
 *
 * Management's spreadsheet lists a city ("Localisation") but no gouvernorat,
 * so both the seed and .xlsx imports derive it from here. Matching ignores
 * case and accents ("BEJA", "Béja" and "beja" all resolve to Béja).
 */

"use strict";

const GOVERNORATES = [
  "Ariana", "Béja", "Ben Arous", "Bizerte", "Gabès", "Gafsa", "Jendouba",
  "Kairouan", "Kasserine", "Kébili", "Kef", "Mahdia", "Manouba", "Médenine",
  "Monastir", "Nabeul", "Sfax", "Sidi Bouzid", "Siliana", "Sousse",
  "Tataouine", "Tozeur", "Tunis", "Zaghouan",
];

// Cities and spellings seen in the agency list, plus the governorate seats.
const CITY_TO_GOV = {
  "ariana": "Ariana", "la soukra": "Ariana", "soukra": "Ariana", "raoued": "Ariana",
  "beja": "Béja",
  "ben arous": "Ben Arous", "ezzahra": "Ben Arous", "hammam lif": "Ben Arous",
  "hammam-lif": "Ben Arous", "megrine": "Ben Arous", "rades": "Ben Arous",
  "sidi rezig megrine": "Ben Arous", "sidi rezig, megrine": "Ben Arous", "mornag": "Ben Arous",
  "bizerte": "Bizerte", "ras ejbal": "Bizerte", "ras jebel": "Bizerte", "menzel bourguiba": "Bizerte",
  "gabes": "Gabès", "el haamma": "Gabès", "el hamma": "Gabès", "mareth": "Gabès",
  "gafsa": "Gafsa",
  "jendouba": "Jendouba", "tabarka": "Jendouba",
  "kairouan": "Kairouan",
  "kasserine": "Kasserine",
  "douz": "Kébili", "kebili": "Kébili",
  "kef": "Kef", "le kef": "Kef",
  "mahdia": "Mahdia",
  "manouba": "Manouba",
  "medinine": "Médenine", "medenine": "Médenine", "djerba": "Médenine", "jerba": "Médenine",
  "ben gueden": "Médenine", "ben gardane": "Médenine", "zarzis": "Médenine",
  "monastir": "Monastir",
  "nabeul": "Nabeul", "hammamet": "Nabeul", "korba": "Nabeul", "kelibia": "Nabeul",
  "sfax": "Sfax",
  "sidi bouzid": "Sidi Bouzid",
  "siliana": "Siliana",
  "sousse": "Sousse",
  "tatouine": "Tataouine", "tataouine": "Tataouine",
  "tozeur": "Tozeur",
  "tunis": "Tunis", "la marsa": "Tunis", "marsa": "Tunis", "le bardo": "Tunis", "el menzah": "Tunis",
  "zaghouene": "Zaghouan", "zaghouan": "Zaghouan",
};

/** Lower-case, accent-stripped, single-spaced. */
function normalize(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

/** Gouvernorat for a city label, or "" when unknown. */
function governorateForCity(city) {
  const key = normalize(city);
  if (!key) return "";
  if (CITY_TO_GOV[key]) return CITY_TO_GOV[key];
  const gov = GOVERNORATES.find((g) => normalize(g) === key);
  return gov || "";
}

module.exports = { GOVERNORATES, governorateForCity, normalize };
