/**
 * Fictional partner-lab PDFs for the import tests, drawn at test time in the two layouts report-reader
 * supports (the same drawing as report-reader's scripts/make-fixtures.ts). Everything is made up: patients,
 * doctors, signatures (generated squiggles), registration and certificate numbers. Never add real reports.
 */
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { toPng } from "@mgpl-diagnostics/report-reader";

const W = 595.28, H = 841.89;

/** A fake "signature": deterministic squiggle on a transparent background. */
function squiggle(w: number, h: number, seed: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const a = 0.25 + rnd() * 0.2, f = 2 + rnd() * 4, ph = rnd() * 6;
  for (let x = 4; x < w - 4; x++) {
    const y = Math.round(h / 2 + Math.sin((x / w) * Math.PI * f + ph) * h * a + Math.sin(x / 7) * h * 0.08);
    for (let t = -2; t <= 2; t++) {
      const yy = y + t;
      if (yy < 0 || yy >= h) continue;
      const j = (yy * w + x) * 4;
      rgba[j] = 20; rgba[j + 1] = 40; rgba[j + 2] = 140; rgba[j + 3] = 255;
    }
  }
  return toPng({ width: w, height: h, rgba });
}

async function page(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
  const p = doc.addPage([W, H]);
  const text = (x: number, yTop: number, s: string, size = 7.5, f: PDFFont = font) => p.drawText(s, { x, y: H - yTop, size, font: f });
  return { p, text, bold };
}

async function image(doc: PDFDocument, p: PDFPage, png: Buffer, x: number, yTop: number, w: number, h: number) {
  const img = await doc.embedPng(png);
  p.drawImage(img, { x, y: H - yTop - h, width: w, height: h });
}

export async function hypathoPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sig = squiggle(210, 130, 7);
  const header = (text: (x: number, y: number, s: string, size?: number, f?: PDFFont) => void, n: number, of: number) => {
    text(472, 39, "PROCESSED AT:", 8, bold);
    text(472, 50, "HY PATHO LAB", 8, bold);
    text(472, 61, "RAIPUR", 8, bold);
    text(20, 148, "PT Name"); text(70, 148, ": MR. TEST PATIENT"); text(240, 148, "Age"); text(308, 148, ": 40 Y | Gender : MALE"); text(426, 148, "SAMPLE COLLECTED AT :");
    text(20, 157, "Ref By Dr"); text(70, 157, ": SELF"); text(240, 157, "Registered on"); text(308, 157, ": 01-01-2026 09:00 AM"); text(426, 157, "DEMO COLLECTION CENTRE");
    text(20, 166, "Booking Id"); text(70, 166, ": 100001 DEMO - 1"); text(240, 166, "Received on"); text(308, 166, ": 01-01-2026 10:00 AM");
    text(308, 175, ": 01-01-2026 05:30 PM");
    text(20, 178, "Barcode Id"); text(70, 178, ": BC0001"); text(240, 178, "Reported on"); text(426, 178, "SAMPLE"); text(462, 178, ": SERUM");
    text(20, 187, "INV"); text(70, 187, ": DEMO PANEL");
    text(298, 815, `${n} of ${of}`);
  };
  const th = (text: (x: number, y: number, s: string, size?: number, f?: PDFFont) => void, y: number) => {
    text(20, y, "TEST DESCRIPTION", 8, bold); text(246, y, "RESULT", 8, bold); text(330, y, "UNITS", 8, bold); text(415, y, "BIO. REF. RANGES", 8, bold);
  };

  // page 1: a panel that continues on page 2
  let { p, text } = await page(doc, font, bold);
  header(text, 1, 3);
  text(222, 216, "COMPLETE BLOOD COUNT", 9, bold);
  th(text, 243);
  text(20, 262, "Hemoglobin"); text(246, 262, "9.50"); text(330, 262, "g/dL"); text(415, 262, "13 - 17");
  text(20, 271, "Method: SLS-Hemoglobin");
  text(20, 289, "Mean Corpuscular Hemoglobin Concentration"); text(246, 289, "35.80"); text(330, 289, "g/dl"); text(415, 289, "31.5 - 34.5");
  text(20, 300, "(MCHC)");
  text(20, 310, "Method: Calculated");
  text(20, 328, "DIFFERENTIAL COUNT", 7.5, bold);
  text(20, 346, "Neutrophils"); text(246, 346, "62"); text(330, 346, "%"); text(415, 346, "40 - 80");
  text(20, 355, "Method: Flow Cytometry");
  text(20, 790, "Platelet Count"); text(246, 790, "120"); text(330, 790, "10^3/uL"); text(415, 790, "150 - 410");

  // page 2: continuation (no title), method line carried over, end of report, signature
  ({ p, text } = await page(doc, font, bold));
  header(text, 2, 3);
  th(text, 211);
  text(20, 225, "Method: Electrical Impedance");
  text(20, 243, "Erythrocyte Sedimentation Rate (ESR)"); text(246, 243, "34"); text(330, 243, "mm at end of Ist hr"); text(415, 243, "0 - 20");
  text(236, 300, "~~End of report~~");
  await image(doc, p, sig, 430, 720, 120, 74);

  // page 3: a marked single test with narrative notes
  ({ p, text } = await page(doc, font, bold));
  header(text, 3, 3);
  text(223, 216, "* THYROID PROFILE", 9, bold);
  th(text, 243);
  text(20, 262, "THYROID STIMULATING HORMONE (TSH)"); text(246, 262, "6.20"); text(330, 262, "uIU/ml"); text(415, 262, "0.35 - 5.5");
  text(20, 271, "Method: CLIA");
  text(25, 300, "Interpretation: values vary with time of day; repeat if clinically indicated.");
  text(236, 340, "~~End of report~~");
  await image(doc, p, sig, 430, 720, 120, 74);

  return doc.save();
}

export async function clinovaPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = squiggle(150, 80, 11), right = squiggle(250, 68, 23);

  const make = async (n: number, of: number, sampleId: string, sampleType: string, dept: string, accredited: boolean) => {
    const { p, text } = await page(doc, font, bold);
    text(242, 96, "LABORATORY TEST REPORT", 10, bold);
    text(30, 117, "Patient Name"); text(94, 117, "Mr DEMO PERSON", 8, bold);
    text(30, 131, "Age : 35 Year(s) Gender : Male");
    text(344, 141, "Lab Code"); text(461, 141, ":"); text(470, 141, "CPL-XX-001");
    text(30, 145, "Sample ID"); text(119, 145, ":"); text(128, 145, sampleId);
    text(344, 156, "Sample Collection Date"); text(461, 156, ":"); text(470, 156, "2026-01-02 08:15");
    text(30, 159, "Sample Type"); text(119, 159, ":"); text(128, 159, sampleType);
    text(30, 171, "Patient ID"); text(119, 171, ":"); text(128, 171, "900001"); text(344, 171, "Registration Date"); text(461, 171, ":"); text(470, 171, "2026-01-02 10:00");
    text(30, 186, "Ref. Doctor"); text(119, 186, ":"); text(344, 186, "Approved"); text(389, 186, "Date"); text(461, 186, ":"); text(470, 186, `2026-01-02 1${n}:30`);
    text(30, 200, "Ref. Customer"); text(119, 200, ":"); text(128, 200, "DEMO COLLECTION CENTRE");
    text(236, 220, dept, 8, bold);
    text(32, 242, "Test Description", 8, bold); text(310, 242, "Result", 8, bold); text(372, 242, "Units", 8, bold); text(414, 242, "Biological Reference Ranges", 8, bold);
    await image(doc, p, left, 29, 736, 116, 21);
    await image(doc, p, right, 404, 735, 134, 22);
    text(30, 769, "Demo Manager"); text(404, 769, "Dr Demo Pathologist, MD");
    text(30, 784, "Manager Lab Operations"); text(404, 784, "Consultant Pathologist (XYMC1234/2020)");
    text(30, 808, "This is an electronically authenticated report.", 5);
    text(543, 808, `Page ${n} of ${of}`, 5);
    if (accredited) text(30, 822, "Tests marked with NABL symbol are accredited by NABL vide Certificate No.MC-9999", 5);
    text(30, 830, "Processed at : Clinova Pathlabs, Demo Central Lab, Demo City - 000000", 5);
    return text;
  };

  let text = await make(1, 2, "S-001", "Serum", "CLINICAL BIOCHEMISTRY", true);
  text(39, 262, "LIPID PROFILE");
  text(39, 277, "Cholesterol - Total"); text(310, 277, "245"); text(369, 277, "mg/dL"); text(426, 277, "<200 - Desirable");
  text(39, 285, "(Method: CHOD-PAP)", 6);
  text(426, 289, "200-239 - Borderline risk");
  text(426, 300, ">240 - High risk");
  text(39, 311, "Cholesterol - HDL"); text(310, 311, "35"); text(369, 311, "mg/dL"); text(426, 311, "40 - 60");
  text(39, 320, "(Method: Enzymatic Colorimetric)", 6);
  text(33, 360, "HDL cholesterol below 40 mg/dL is a cardiovascular risk factor. Correlate clinically with other findings.");

  text = await make(2, 2, "S-002", "WB EDTA", "HEMATOLOGY", false);
  text(39, 260, "Erythrocyte Sedimentation Rate (ESR)"); text(310, 260, "30"); text(369, 260, "mm/Hour"); text(426, 260, "<= 20");
  text(39, 269, "(Method: Westergren)", 6);
  text(248, 500, "--End of Report--");

  return doc.save();
}
