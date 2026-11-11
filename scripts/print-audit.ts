/**
 * Print audit: renders EVERY catalog test the way the api prints it and checks the PDFs.
 *
 *   npm run print-audit                 # all tests (~8 min per 150 tests; run ranges in parallel)
 *   npm run print-audit -- 0 150        # a range of TESTS
 *   ONLY=CBC,WIDS npm run print-audit   # chosen codes
 *   OUT=dir KEEP=1 …                    # keep the PDFs of tests with findings in OUT (default print-audit/)
 *
 * Each test gets plausible values (mid-range numbers, a valid option, text), goes through
 * withCatalogDefaults (units, ranges, flags, calculated values) and DocumentService's own section
 * builder, is rendered with report-kit (sidebar design, header variant) and read back with
 * report-reader's text layer. Findings: render errors, results missing from the page, calculated values
 * not printed, ranges that are option lists / placeholders / essays, text past the right edge, items
 * colliding on a line or across lines. Not part of `npm test` (too slow); run it after catalog-kit,
 * report-kit or document changes.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { TESTS, rangeFor, type Parameter } from "@mgpl-diagnostics/catalog-kit";
import { defaultLab, renderReportPdf, type Report as PrintReport } from "@mgpl-diagnostics/report-kit";
import { DocumentService, printPatient } from "../src/services/document.service";
import { withCatalogDefaults } from "../src/services/report.service";
import { readPdf } from "@mgpl-diagnostics/report-reader";

const [from = "0", to = String(TESTS.length)] = process.argv.slice(2);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const OUT = process.env.OUT ?? "print-audit";
mkdirSync(OUT, { recursive: true });
const svc = new DocumentService({} as never, { samples: false });
const at = new Date("2026-11-11T09:00:00Z");
const patient = printPatient({ title: "Mr", name: "Audit Patient", sex: "male", ageYears: 35, uhid: "MGPL-000099", phone: "9000000000" } as never, at, {
  refDoctor: "Self", sampleId: "S26000123", sampleCollectionDate: at, collectedAt: at, registeredAt: at, reportedAt: at,
});

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
function sampleValue(p: Parameter): string {
  if (p.type === "options") return (p.options ?? []).find((o) => o && o !== "-") ?? "NEGATIVE";
  if (p.type === "numeric") {
    const r = rangeFor(p, "male");
    const lo = num(r?.low), hi = num(r?.high);
    const v = lo != null && hi != null ? (lo + hi) / 2 : hi != null ? hi * 0.8 : lo != null ? lo * 1.2 : 12.5;
    return String(Math.round(v * 100) / 100);
  }
  return "Normal study";
}

type Finding = { code: string; name: string; kind: string; detail: string };
const findings: Finding[] = [];
const add = (t: { code: string | null; name: string }, kind: string, detail: string) => findings.push({ code: t.code ?? "?", name: t.name, kind, detail });
let pages = 0, rendered = 0;
const t0 = Date.now();

for (const t of TESTS.slice(+from, +to).filter((x) => !ONLY || ONLY.has(x.code ?? ""))) {
  try {
    const params = t.parameters.filter((p) => p.name && p.type !== "title" && p.type !== "image");
    const entered = params.filter((p) => !(p.calculated && p.formulaText && !/\bpr_\d+/.test(p.formulaText))).map((p) => ({ parameter: p.name!, value: sampleValue(p) }));
    const results = withCatalogDefaults(t.code ?? "", entered, "male", 35);
    // checks on the data that prints
    for (const r of results) {
      if (r.range && /(^|\s)-\s*\/|\/\s*-(\s|$)/.test(r.range)) add(t, "range-placeholder", `${r.parameter}: "${r.range}"`);
      if (r.range && r.range.split("/").length >= 3 && !/\d/.test(r.range)) add(t, "range-is-options-list", `${r.parameter}: "${r.range}"`);
      if (r.range && r.range.length > 140) add(t, "range-very-long", `${r.parameter}: ${r.range.length} chars`);
    }
    const missing = params.filter((p) => p.calculated && !results.some((r) => r.parameter === p.name));
    if (missing.length) add(t, "calculated-not-printed", missing.map((p) => p.name).join(", "));
    const dbReport = { testCode: t.code, testName: t.name, results } as never;
    const sections = (svc as unknown as { sections(r: unknown, p: unknown): PrintReport["sections"] }).sections(dbReport, patient);
    const report: PrintReport = { patient, sections };
    const pdf = await renderReportPdf({ report, variant: "header", design: "sidebar", lab: defaultLab() });
    rendered++;
    const doc = await readPdf(new Uint8Array(pdf), { images: false });
    pages += doc.pages.length;
    if (doc.pages.length > 3) add(t, "many-pages", `${doc.pages.length} pages`);
    const printed = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n").toLowerCase();
    const absent = results.filter((r) => !printed.includes(r.parameter.toLowerCase().replace(/\s+/g, " ").slice(0, 18)));
    if (absent.length) add(t, "result-not-on-page", absent.map((r) => r.parameter).slice(0, 6).join(", "));
    for (const page of doc.pages) {
      // vertical collisions, item by item, in the content column only (the sidebar letters sit left of 61pt)
      const items = page.lines.flatMap((l) => l.items.filter((i) => i.x >= 61 && i.s.trim().length > 2).map((i) => ({ ...i, y: l.y })));
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const A = items[i]!, B = items[j]!;
        const dy = Math.abs(A.y - B.y);
        if (dy < 0.5 || dy >= 5.5) continue;
        if (A.x < B.x + B.w && B.x < A.x + A.w) add(t, "lines-collide", `p${page.number} "${A.s.slice(0, 25)}" (y${Math.round(A.y)}) over "${B.s.slice(0, 25)}" (y${Math.round(B.y)})`);
      }
      for (const line of page.lines) {
        // content column of the sidebar design: 0.85in … 7.82in (61 … 563 pt); the vertical lab name sits left of it
        for (const it of line.items) if (it.x > 55 && it.x + it.w > 566) add(t, "past-right-edge", `p${page.number} y${Math.round(line.y)} "${it.s.slice(0, 40)}" ends at ${Math.round(it.x + it.w)}pt`);
        const items = [...line.items].sort((a, b) => a.x - b.x);
        for (let i = 1; i < items.length; i++) {
          const a = items[i - 1]!, b = items[i]!;
          if (a.x >= 61 && a.s.trim().length > 2 && b.s.trim().length > 2 && a.x + a.w > b.x + 1.5) add(t, "cells-overlap", `p${page.number} "${a.s.slice(0, 30)}" runs into "${b.s.slice(0, 20)}"`);
        }
      }
    }
    if (process.env.KEEP && findings.some((f) => f.code === t.code)) writeFileSync(`${OUT}/${t.code}.pdf`, pdf);
  } catch (e) {
    add(t, "render-error", String((e as Error).message).slice(0, 160));
  }
}

const byKind = new Map<string, Finding[]>();
for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
writeFileSync(`${OUT}/findings-${from}-${to}.json`, JSON.stringify(findings, null, 1));
console.log(`${rendered} rendered, ${pages} pages, ${findings.length} findings in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
  const tests = new Set(list.map((f) => f.code));
  console.log(`\n${k}: ${list.length} in ${tests.size} tests`);
  for (const f of list.slice(0, 6)) console.log(`  ${f.code} | ${f.name.slice(0, 40)} | ${f.detail}`);
}
