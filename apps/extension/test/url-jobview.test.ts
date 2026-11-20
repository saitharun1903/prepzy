import { describe, expect, it } from "vitest";
import { alternativesText, requirementView, splitRequirements, toApplicationView, toJobView, toLookupView } from "../src/shared/jobview";
import { classifyUrl, dashboardJobUrl, normalizeUrl, sameUrl } from "../src/shared/url";

describe("normalizeUrl", () => {
  it("drops fragments, tracking params and default ports; sorts params", () => {
    expect(normalizeUrl("HTTPS://Careers.Example.TEST:443/jobs/1/?utm_source=x&b=2&a=1#apply")).toBe("https://careers.example.test/jobs/1?a=1&b=2");
    expect(normalizeUrl("https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=r")).toBe("https://www.linkedin.com/jobs/view/123?refId=r&trackingId=abc");
  });
  it("keeps meaningful params such as a selected job id", () => {
    expect(normalizeUrl("https://www.linkedin.com/jobs/search/?currentJobId=1")).not.toBe(normalizeUrl("https://www.linkedin.com/jobs/search/?currentJobId=2"));
  });
  it("rejects non-web URLs", () => {
    expect(normalizeUrl("chrome://extensions")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
  it("compares pages", () => {
    expect(sameUrl("https://a.example/x#1", "https://a.example/x?utm_medium=y")).toBe(true);
    expect(sameUrl("https://a.example/x", "https://a.example/y")).toBe(false);
  });
});

describe("classifyUrl", () => {
  it.each([
    ["chrome://settings", "restricted"],
    ["edge://extensions", "restricted"],
    ["about:blank", "restricted"],
    ["chrome-extension://abc/popup.html", "restricted"],
    ["file:///C:/jobs/posting.html", "restricted"],
    ["https://chromewebstore.google.com/detail/x", "restricted"],
    ["https://chrome.google.com/webstore/detail/x", "restricted"],
    ["https://microsoftedge.microsoft.com/addons/detail/x", "restricted"],
    ["https://careers.example.test/files/job.pdf", "pdf"],
    [undefined, "unknown"],
    ["https://careers.example.test/jobs/1", "ok"],
  ])("%s -> %s", (url, kind) => {
    expect(classifyUrl(url as string | undefined).kind).toBe(kind);
  });
});

describe("dashboardJobUrl", () => {
  it("only accepts UUID job ids and never carries tokens", () => {
    expect(dashboardJobUrl("http://localhost:3000/", "3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12")).toBe("http://localhost:3000/jobs/3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12");
    expect(dashboardJobUrl("http://localhost:3000", "../admin?token=x")).toBeNull();
  });
});

const sampleJob = {
  job: { id: "3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12", title: "Senior Data Engineer", company: "Fernhill Analytics", source_url: "https://x.example/1", saved: true },
  analysis: {
    id: "a1",
    status: "partial",
    model: "qwen3:8b",
    prompt_version: "job-v3",
    schema_version: "2",
    is_latest: true,
    stale: false,
    issues: [{ code: "truncated", section: "requirements", message: "The posting was truncated." }, { bogus: true }],
    result: {
      fields: {
        title: { value: "Senior Data Engineer", source: "job_text", evidence: { quote: "Senior Data Engineer" } },
        company: { value: "Fernhill", source: "job_text", conflict: { structured_data: "Fernhill Analytics" } },
        location: { value: null, source: "unknown" },
        salary: { value: null, source: "structured_data", structured: { currency: "INR", min: 2400000, max: 3200000, period: "YEAR" } },
      },
      requirements: [
        { key: "r1", text: "5+ years of experience", importance: "required", group: "single", concepts: [], notes: [] },
        { key: "r2", text: "Python or Scala", importance: "required", group: "any", concepts: [{ id: "python", label: "Python" }, { id: "scala", label: "Scala" }] },
        { key: "r3", text: "Kafka", importance: "preferred", group: "single", concepts: [{ id: "kafka", label: "Kafka" }] },
        { key: "r4", text: "Airflow and dbt", importance: "unclear", group: "all", concepts: [{ label: "Airflow" }, { label: "dbt" }] },
        { key: "r5", text: "Weird", importance: "<script>", group: "any", concepts: [] },
        { text: "no key" },
      ],
    },
  },
  history: [{}, {}],
  active_operations: [],
};

describe("toJobView", () => {
  const v = toJobView(sampleJob)!;
  it("extracts summary fields with unknowns as null", () => {
    expect(v.job.saved).toBe(true);
    expect(v.analysis!.fields.title.value).toBe("Senior Data Engineer");
    expect(v.analysis!.fields.location.value).toBeNull();
    expect(v.analysis!.fields.company.conflict).toBe("Fernhill Analytics");
    expect(v.analysis!.fields.salary.value).toBe("INR 2400000 3200000 / YEAR");
    expect(v.analysis!.fields.deadline.value).toBeNull();
    expect(v.analysis!.model).toBe("qwen3:8b");
    expect(v.historyCount).toBe(2);
  });
  it("keeps only well-formed requirements and issues", () => {
    expect(v.analysis!.requirements.map((r) => r.key)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(v.analysis!.requirements[4]!.importance).toBe("unclear");
    expect(v.analysis!.issues).toHaveLength(1);
  });
  it("splits required vs preferred and shows alternatives as 'A or B'", () => {
    const g = splitRequirements(v.analysis!.requirements);
    expect(g.required.map((r) => r.key)).toEqual(["r1", "r2"]);
    expect(g.preferred.map((r) => r.key)).toEqual(["r3"]);
    expect(g.unclear.map((r) => r.key)).toEqual(["r4", "r5"]);
    expect(alternativesText(g.required[1]!.alternatives)).toBe("Python or Scala");
    expect(alternativesText(g.unclear[0]!.alternatives)).toBeNull(); // "all" group is not an either/or
  });
  it("rejects malformed jobs", () => {
    expect(toJobView({})).toBeNull();
    expect(toJobView({ job: { title: "x" } })).toBeNull();
    expect(requirementView(null)).toBeNull();
  });
});

describe("lookup / applications", () => {
  it("parses lookup responses", () => {
    expect(toLookupView({ job: null })).toBeNull();
    expect(toLookupView({ job: { id: "j", title: "T", company: null, saved: false, latest_analysis_id: "a" } })).toEqual({ id: "j", title: "T", company: null, saved: false, latestAnalysisId: "a" });
  });
  it("parses applications", () => {
    expect(toApplicationView({ id: "a", status: "planned", version: 2 })).toEqual({ id: "a", status: "planned", version: 2 });
    expect(toApplicationView({ id: "a", status: "planned" })).toBeNull();
  });
});

describe("looksLikeJobPage + interview research links", () => {
  it("recognises single job postings and skips search pages", async () => {
    const { looksLikeJobPage } = await import("../src/shared/url");
    expect(looksLikeJobPage("https://www.linkedin.com/jobs/view/4012345678/")).toBe(true);
    expect(looksLikeJobPage("https://www.linkedin.com/jobs/search/?keywords=java")).toBe(false);
    expect(looksLikeJobPage("https://www.linkedin.com/jobs/search/?currentJobId=401")).toBe(true);
    expect(looksLikeJobPage("https://in.indeed.com/viewjob?jk=abc123")).toBe(true);
    expect(looksLikeJobPage("https://boards.greenhouse.io/acme/jobs/123")).toBe(true);
    expect(looksLikeJobPage("https://acme.com/careers/backend-engineer")).toBe(true);
    expect(looksLikeJobPage("https://news.ycombinator.com/item?id=1")).toBe(false);
    expect(looksLikeJobPage("chrome://extensions")).toBe(false);
  });

  it("builds loose, encoded search links that work for small companies", async () => {
    const { interviewResearchLinks } = await import("../src/shared/research");
    const links = interviewResearchLinks("Scoutit & Co", "Java Developer (SE) - Hyderabad");
    expect(links.map((l) => l.id)).toEqual(["glassdoor", "ambitionbox", "leetcode", "gfg", "reddit", "google", "role"]);
    for (const l of links) expect(l.url.startsWith("https://")).toBe(true);
    expect(links[0]!.url).toBe("https://www.glassdoor.co.in/Search/results.htm?keyword=Scoutit%20%26%20Co");
    for (const l of links) {
      expect(decodeURIComponent(l.url)).not.toContain('"'); // no exact-match quotes
      expect(decodeURIComponent(l.url)).not.toContain("site:"); // no stacked site filters
      expect(decodeURIComponent(l.url)).not.toContain("Hyderabad");
    }
    expect(links.at(-1)!.label).toBe("Java Developer questions");
    expect(interviewResearchLinks(null, "Data Analyst").map((l) => l.id)).toEqual(["role"]);
    expect(interviewResearchLinks(null, null)).toEqual([]);
  });
});
