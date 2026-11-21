"""Link import: parsing of LinkedIn guest pages and schema.org JobPosting, and SSRF guards."""

import pytest

from elevate.services import link_import as li

LINKEDIN_HTML = """
<section class="top-card-layout"><h2 class="top-card-layout__title font-sans">Back End Developer Intern</h2>
<h4><span class="topcard__flavor"><a class="topcard__org-name-link topcard__flavor--black-link" href="#">
 Jobs4PanIndia </a></span><span class="topcard__flavor topcard__flavor--bullet">Hyderabad, Telangana, India</span></h4></section>
<div class="description__text description__text--rich"><section class="show-more-less-html">
<div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">
<strong>About the role</strong><br>We are hiring an intern.<br><br><strong>Requirements:</strong>
<ul><li>Basic understanding of any programming language.</li><li>Familiarity with databases, APIs, or backend development.</li></ul>
<div><p>Nested &amp; escaped</p></div></div></section></div>
<ul class="description__job-criteria-list"><li class="description__job-criteria-item">
<h3 class="description__job-criteria-subheader">Seniority level</h3>
<span class="description__job-criteria-text description__job-criteria-text--criteria"> Internship </span></li></ul>
<script>alert(1)</script>
"""

JSONLD_HTML = """<html><head><title>Careers</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},
{"@type":"JobPosting","title":"Java Developer","hiringOrganization":{"@type":"Organization","name":"Acme Corp"},
"jobLocation":{"@type":"Place","address":{"addressLocality":"Pune","addressCountry":"IN"}},
"employmentType":"FULL_TIME","description":"&lt;p&gt;Build services in &lt;b&gt;Java&lt;/b&gt; and Spring Boot.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;3+ years Java&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;"}]}
</script></head><body><main>ignored</main></body></html>"""


def test_linkedin_job_id_from_any_linkedin_job_url():
    assert li.linkedin_job_id("https://www.linkedin.com/jobs/view/4492954113/") == "4492954113"
    assert li.linkedin_job_id("https://in.linkedin.com/jobs/view/back-end-developer-intern-at-x-4492954113?trk=a") == "4492954113"
    assert li.linkedin_job_id("https://www.linkedin.com/jobs/search-results/?currentJobId=4492954113&eBP=x") == "4492954113"
    assert li.linkedin_job_id("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=123456789") == "123456789"
    assert li.linkedin_job_id("https://www.naukri.com/job-listings-123456789") is None


def test_parse_linkedin_guest_page():
    got = li.parse_linkedin(LINKEDIN_HTML, "https://www.linkedin.com/jobs/view/1/")
    assert got and got.title == "Back End Developer Intern"
    assert got.company == "Jobs4PanIndia" and got.location == "Hyderabad, Telangana, India"
    assert "- Basic understanding of any programming language." in got.text
    assert "Nested & escaped" in got.text and "Seniority level: Internship" in got.text
    assert "alert" not in got.text


def test_parse_jsonld_jobposting():
    got = li.parse_jsonld(JSONLD_HTML, "https://acme.example/jobs/1")
    assert got and got.source == "jsonld" and got.title == "Java Developer" and got.company == "Acme Corp"
    assert got.location == "Pune, IN"
    assert "Build services in Java and Spring Boot." in got.text and "- 3+ years Java" in got.text
    assert "Employment type: FULL_TIME" in got.text


@pytest.mark.parametrize("url", ["ftp://x.com/a", "https://user:pw@example.com/", "http://example.com:8080/",
                                 "http://localhost/", "http://metadata.google.internal/"])
def test_check_url_rejects_unsafe(url):
    with pytest.raises(li.LinkError):
        li.check_url(url)


@pytest.mark.parametrize("host", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "100.64.0.1"])
def test_private_addresses_are_blocked(host):
    with pytest.raises(li.LinkError) as e:
        li._public_host(host)
    assert e.value.code == "link_blocked"


def test_bare_domain_gets_https():
    assert li.check_url("careers.example.com/jobs/1") == "https://careers.example.com/jobs/1"


def test_import_link_uses_linkedin_guest_api(monkeypatch):
    seen = {}

    def fake_fetch(url, accept=None):
        seen["url"] = url
        return url, LINKEDIN_HTML
    monkeypatch.setattr(li, "_fetch", fake_fetch)
    got = li.import_link("https://www.linkedin.com/jobs/search-results/?currentJobId=4492954113")
    assert seen["url"] == "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4492954113"
    assert got.url == "https://www.linkedin.com/jobs/view/4492954113/" and got.source == "linkedin"


def test_js_rendered_sites_explain_to_use_the_extension(monkeypatch):
    monkeypatch.setattr(li, "_fetch", lambda url, accept=None: (url, "<html><title>Naukri</title><body><div id='root'></div></body></html>"))
    with pytest.raises(li.LinkError) as e:
        li.import_link("https://www.naukri.com/job-listings-java-developer-acme-1-to-3-years-123456789012")
    assert e.value.code == "link_needs_extension" and "extension" in e.value.message


def test_generic_page_title_split():
    doc = "<html><title>Job Application for Backend Engineer at Acme</title><body><main>" + \
          "<h1>Backend Engineer</h1><p>Responsibilities: build APIs in Java. " + "x " * 120 + "</p></main></body></html>"
    got = li.parse_page(doc, "https://job-boards.greenhouse.io/acme/jobs/1")
    assert got and got.title == "Backend Engineer" and got.company == "Acme"


def test_linkedin_falls_back_to_job_page_when_rate_limited(monkeypatch):
    calls = []

    def fake_fetch(url, accept=None):
        calls.append(url)
        if "jobs-guest" in url:
            raise li.LinkError("blocked", "link_blocked_by_site")
        return url, LINKEDIN_HTML
    monkeypatch.setattr(li, "_fetch", fake_fetch)
    got = li.import_link("https://www.linkedin.com/jobs/view/4492954113/")
    assert got.title == "Back End Developer Intern" and calls[-1] == "https://www.linkedin.com/jobs/view/4492954113/"
