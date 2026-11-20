/**
 * Links that open real interview-experience searches for a company and role in the user's own browser.
 * Prepzy never scrapes these sites: the user reads them directly, under each site's own terms.
 */
export type ResearchLink = { id: string; label: string; hint: string; url: string };

function q(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
}

export function interviewResearchLinks(company: string | null | undefined, title: string | null | undefined): ResearchLink[] {
  const c = (company ?? "").trim().slice(0, 80);
  const t = (title ?? "").replace(/\(.*?\)/g, "").trim().slice(0, 80);
  if (!c && !t) return [];
  const g = (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const who = c ? `"${c}"` : "";
  return [
    { id: "glassdoor", label: "Glassdoor", hint: "Interview reviews and questions", url: g(q([who, t, "interview questions site:glassdoor.com OR site:glassdoor.co.in"])) },
    { id: "ambitionbox", label: "AmbitionBox", hint: "Interview rounds (popular in India)", url: g(q([who, t, "interview site:ambitionbox.com"])) },
    { id: "leetcode", label: "LeetCode Discuss", hint: "Coding-round experiences", url: g(q([who, t, "interview experience site:leetcode.com/discuss"])) },
    { id: "gfg", label: "GeeksforGeeks", hint: "Detailed round-by-round write-ups", url: g(q([who, "interview experience site:geeksforgeeks.org"])) },
    { id: "reddit", label: "Reddit", hint: "Candid discussions", url: `https://www.reddit.com/search/?q=${encodeURIComponent(q([c, t, "interview"]))}` },
    { id: "google", label: "Search the web", hint: "Everything else", url: g(q([who, t, "interview experience questions rounds"])) },
  ];
}
