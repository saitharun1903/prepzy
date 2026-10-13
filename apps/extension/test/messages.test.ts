import { describe, expect, it } from "vitest";
import { isAllowedConnectSender, isTrustedUiSender, validateConnectMessage, validateUiRequest } from "../src/shared/messages";

const ID = "bjhbbpnbmichlooillmiaeofcioofkni";
const ORIGIN = `chrome-extension://${ID}`;
const UUID = "3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz";

describe("validateConnectMessage", () => {
  it("accepts a well-formed connect message", () => {
    expect(validateConnectMessage({ type: "elevate.connect.v1", refresh_token: TOKEN })).toEqual({ type: "elevate.connect.v1", refresh_token: TOKEN });
  });
  it.each([
    ["wrong type", { type: "elevate.connect.v2", refresh_token: TOKEN }],
    ["short token", { type: "elevate.connect.v1", refresh_token: "abc" }],
    ["long token", { type: "elevate.connect.v1", refresh_token: "a".repeat(201) }],
    ["non-urlsafe chars", { type: "elevate.connect.v1", refresh_token: "abc def+/=abcdefghijklmnop" }],
    ["number token", { type: "elevate.connect.v1", refresh_token: 12345678901234567890 }],
    ["extra keys", { type: "elevate.connect.v1", refresh_token: TOKEN, api: "https://evil.example" }],
    ["array", [TOKEN]],
    ["null", null],
  ])("rejects %s", (_n, m) => {
    expect(validateConnectMessage(m)).toBeNull();
  });
});

describe("isAllowedConnectSender", () => {
  const allowed = ["http://localhost:3000"];
  it("accepts the configured web origin only", () => {
    expect(isAllowedConnectSender({ origin: "http://localhost:3000", url: "http://localhost:3000/extension/connect" }, allowed)).toBe(true);
    expect(isAllowedConnectSender({ origin: "http://localhost:3001", url: "http://localhost:3001/x" }, allowed)).toBe(false);
    expect(isAllowedConnectSender({ origin: "https://localhost:3000" }, allowed)).toBe(false);
    expect(isAllowedConnectSender({ url: "http://localhost:3000/x" }, allowed)).toBe(false);
    expect(isAllowedConnectSender({ origin: "http://localhost:3000", url: "http://evil.example/x" }, allowed)).toBe(false);
  });
});

describe("isTrustedUiSender", () => {
  it("accepts this extension's own pages", () => {
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}/popup.html`, origin: ORIGIN }, ID, ORIGIN)).toBe(true);
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}/sidepanel.html` }, ID, `${ORIGIN}/`)).toBe(true);
  });
  it("rejects content scripts, other extensions and web pages", () => {
    expect(isTrustedUiSender({ id: ID, url: "https://careers.example.test/jobs/1", tab: {} }, ID, ORIGIN)).toBe(false);
    expect(isTrustedUiSender({ id: "otherextensionid", url: `chrome-extension://otherextensionid/popup.html` }, ID, ORIGIN)).toBe(false);
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}.evil/popup.html` }, ID, ORIGIN)).toBe(false);
    expect(isTrustedUiSender({ id: ID, url: `${ORIGIN}/popup.html`, origin: "https://evil.example" }, ID, ORIGIN)).toBe(false);
  });
});

describe("validateUiRequest", () => {
  const submit = { v: 1, type: "capture.submit", captureId: UUID, tabId: 4, source: "page", manualText: null, title: "T", company: null, save: false };

  it("accepts valid messages", () => {
    expect(validateUiRequest({ v: 1, type: "state.get", tabId: 3, url: "https://a.example/x" })).not.toBeNull();
    expect(validateUiRequest({ v: 1, type: "state.get", tabId: null, url: null })).not.toBeNull();
    expect(validateUiRequest(submit)).not.toBeNull();
    expect(validateUiRequest({ ...submit, source: "manual", manualText: "x".repeat(300), tabId: null })).not.toBeNull();
    expect(validateUiRequest({ v: 1, type: "job.reminder", jobId: UUID, title: "Follow up", dueDate: "2026-10-20", remindTime: "09:30" })).not.toBeNull();
    expect(validateUiRequest({ v: 1, type: "job.application.set", jobId: UUID, status: "applied" })).not.toBeNull();
  });

  it.each([
    ["unknown type", { v: 1, type: "api.fetch", url: "https://evil.example" }],
    ["wrong version", { ...submit, v: 2 }],
    ["missing version", { type: "auth.logout" }],
    ["extra field", { ...submit, apiBase: "https://evil.example" }],
    ["bad capture id", { ...submit, captureId: "../../etc" }],
    ["negative tab", { ...submit, tabId: -1 }],
    ["page source without tab", { ...submit, tabId: null }],
    ["manual without text", { ...submit, source: "manual", manualText: null }],
    ["page with manual text", { ...submit, manualText: "hello" }],
    ["oversized manual text", { ...submit, source: "manual", manualText: "x".repeat(60_001) }],
    ["oversized title", { ...submit, title: "t".repeat(301) }],
    ["string save", { ...submit, save: "yes" }],
    ["job id path traversal", { v: 1, type: "job.get", jobId: "../admin" }],
    ["bad date", { v: 1, type: "job.reminder", jobId: UUID, title: "x", dueDate: "2026-13-01", remindTime: "09:00" }],
    ["bad time", { v: 1, type: "job.reminder", jobId: UUID, title: "x", dueDate: "2026-10-01", remindTime: "25:00" }],
    ["blank note", { v: 1, type: "job.note", jobId: UUID, body: "   " }],
    ["other status", { v: 1, type: "job.application.set", jobId: UUID, status: "offer" }],
    ["string", "state.get"],
  ])("rejects %s", (_n, m) => {
    expect(validateUiRequest(m)).toBeNull();
  });
});
