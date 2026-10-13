// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { MatchView, RequirementView } from "../src/shared/jobview";
import { avatar, buildChecklist, coach } from "../src/ui/coach";

const req = (key: string, text: string, concepts: string[], importance: RequirementView["importance"] = "required", extra: Partial<RequirementView> = {}): RequirementView => ({
  key, text, importance, concepts, alternatives: null, negated: false, notes: [], years: null, ...extra,
});
const match = (status: MatchView["status"]): MatchView => ({
  reportId: "r", scoreStatus: "available", withheldReason: null,
  required: { coverage: 50, total: 2, met: 1 }, preferred: { coverage: 0, total: 0, met: 0 },
  status, missing: [], hasResume: true, stale: false,
});

describe("checklist", () => {
  it("merges duplicate skills (Java twice) and keeps the assessed status over 'check yourself'", () => {
    const reqs = [
      req("r1", "strong expertise in Java and API development", ["Java"]),
      req("r2", "deep expertise in Core Java (Java 3+)", ["Java"], "required", { years: "3+ yrs" }),
      req("r3", "strong experience in designing enterprise microservices", ["Microservices"]),
    ];
    const items = buildChecklist(reqs, match({ r1: "supported", r2: "unassessable", r3: "not_evidenced" }));
    expect(items.map((i) => [i.label, i.bucket])).toEqual([["Java", "have"], ["Microservices", "missing"]]);
    expect(items[0]!.keys).toEqual(["r1", "r2"]);
    expect(items[0]!.note).toBe("3+ yrs asked");
  });

  it("a missing status wins over 'have' when the same skill is required twice", () => {
    const items = buildChecklist([req("a", "SQL", ["SQL"]), req("b", "Advanced SQL tuning", ["SQL"])], match({ a: "supported", b: "not_evidenced" }));
    expect(items).toHaveLength(1);
    expect(items[0]!.bucket).toBe("missing");
  });
});

describe("coach copy", () => {
  const items = buildChecklist(
    [req("r1", "Java", ["Java"]), req("r3", "Microservices", ["Microservices"])],
    match({ r1: "supported", r3: "not_evidenced" }),
  );

  it("is grounded in the checklist and names the biggest gap", () => {
    const c = coach({ name: null, company: "CGI", items, match: match({ r1: "supported", r3: "not_evidenced" }), partial: false });
    expect(c.mood).toBe("cheer");
    expect(c.verdict).toBe("You match 1 of 2 must-haves at CGI. You're close.");
    expect(c.advice).toContain("Microservices");
    expect(c.primary?.action).toBe("practice");
  });

  it("never invents a name", () => {
    const c = coach({ name: null, company: null, items, match: undefined, partial: false });
    expect(c.greeting).toBe("Here's my read.");
  });

  it("asks for a resume when there is none, and flags partial analyses", () => {
    expect(coach({ name: null, company: null, items, match: null, partial: false }).primary?.action).toBe("resume");
    expect(coach({ name: null, company: null, items, match: match({}), partial: true }).primary?.action).toBe("analyze");
  });

  it("uses singular wording for a single requirement", () => {
    const one = buildChecklist([req("r1", "Java", ["Java"])], match({ r1: "supported" }));
    const c = coach({ name: null, company: null, items: one, match: match({ r1: "supported" }), partial: false });
    expect(c.verdict).toBe("Your resume shows the must-have for this role. You're a strong fit.");
  });

  it("renders an accessible-hidden SVG avatar for every mood", () => {
    for (const m of ["wave", "happy", "cheer", "think"] as const) {
      const svg = avatar(m);
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.querySelectorAll("rect").length).toBeGreaterThan(1);
    }
  });
});
