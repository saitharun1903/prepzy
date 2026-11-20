/**
 * Links that open real interview-experience searches for a company and role in the user's own browser.
 * Prepzy never scrapes these sites: the user reads them directly, under each site's own terms.
 *
 * Queries are deliberately loose (no exact-match quotes, no stacked site: filters) so small companies
 * still return results, and a role-only link covers companies with no published reviews yet.
 */
export type ResearchLink = { id: string; label: string; hint: string; url: string };

function q(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
}

/** "Java Developer (SE) - Remote" -> "Java Developer": drop brackets and location/level suffixes. */
function cleanRole(title: string | null | undefined): string {
  return (title ?? "").replace(/\(.*?\)|\[.*?\]/g, " ").split(/\s[-|–—]\s|,/)[0]!.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Job boards, staffing agencies and recruiters post on behalf of the real employer: searching their
 * name finds nothing useful ("Jobs4PanIndia"), so research falls back to the role. */
const RECRUITER = /\b(jobs?|hiring|careers?|recruit\w*|staffing|placements?|manpower|talent|hr\s+(solutions|services)|outsourc\w*|vacanc\w*)\b|jobs?\d|\d+jobs?/i;

export function isRecruiterName(company: string | null | undefined): boolean {
  return RECRUITER.test((company ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
}

export function interviewResearchLinks(company: string | null | undefined, title: string | null | undefined): ResearchLink[] {
  const raw = (company ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const c = isRecruiterName(raw) ? "" : raw;
  const t = cleanRole(title);
  if (!c && !t) return [];
  const g = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const links: ResearchLink[] = [];
  if (c) {
    links.push(
      { id: "glassdoor", label: "Glassdoor", hint: "Interview reviews for this company",
        url: `https://www.glassdoor.co.in/Search/results.htm?keyword=${encodeURIComponent(c)}` },
      { id: "ambitionbox", label: "AmbitionBox", hint: "Interview rounds (popular in India)", url: g(q([c, "interview experience ambitionbox"])) },
      { id: "leetcode", label: "LeetCode Discuss", hint: "Coding-round experiences", url: g(q([c, "interview experience leetcode discuss"])) },
      { id: "gfg", label: "GeeksforGeeks", hint: "Round-by-round write-ups", url: g(q([c, "interview experience geeksforgeeks"])) },
      { id: "reddit", label: "Reddit", hint: "Candid discussions", url: `https://www.reddit.com/search/?q=${encodeURIComponent(q([c, "interview"]))}` },
      { id: "google", label: "Search the web", hint: "Everything about this company's interviews", url: g(q([c, t, "interview experience"])) },
    );
  }
  if (t && !c) {
    links.push(
      { id: "glassdoor", label: "Glassdoor", hint: "Interview reviews for this role",
        url: `https://www.glassdoor.co.in/Search/results.htm?keyword=${encodeURIComponent(t)}` },
      { id: "gfg", label: "GeeksforGeeks", hint: "Interview write-ups for this role", url: g(q([t, "interview experience geeksforgeeks"])) },
      { id: "reddit", label: "Reddit", hint: "Candid discussions", url: `https://www.reddit.com/search/?q=${encodeURIComponent(q([t, "interview"]))}` },
    );
  }
  if (t) {
    links.push({ id: "role", label: `${t} questions`, hint: "Common questions for this role at any company",
      url: g(q([t, "interview questions and answers"])) });
  }
  return links;
}
