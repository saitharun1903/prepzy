// Storage layout (all account-bound data is cleared on logout or account switch):
//
// chrome.storage.local   (survives browser restart)
//   auth            { refreshToken, userId, email }       refresh token (rotated on every refresh)
//   capturesMirror  MirrorRecord[]                        minimal capture records for restart recovery
// chrome.storage.session (memory only, cleared on browser restart / extension reload)
//   access          { token, expiresAt, userId }          short-lived access token
//   captures        Record<captureId, CaptureRecord>
//   lookupCache     Record<normalizedUrl, { at, job }>
//   extract:<tabId> { url, result }                       last validated page extraction for a tab
//   draft:<tabId>   preview edits written by the UI

export interface StoredAuth {
  refreshToken: string;
  userId: string;
  email: string;
}

export interface StoredAccess {
  token: string;
  expiresAt: number;
  userId: string;
}

export async function getLocal<T>(key: string): Promise<T | undefined> {
  const r = await chrome.storage.local.get(key);
  return r[key] as T | undefined;
}

export async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSession<T>(key: string): Promise<T | undefined> {
  const r = await chrome.storage.session.get(key);
  return r[key] as T | undefined;
}

export async function setSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function removeSession(keys: string | string[]): Promise<void> {
  await chrome.storage.session.remove(keys);
}

/**
 * Restrict storage to trusted (extension) contexts. storage.session already defaults to this;
 * storage.local may not support setAccessLevel in every Chrome version, hence the try/catch.
 * Residual risk: injected extraction code runs as a content script, and a compromised renderer
 * process for a page the user grants could in principle reach storage.local. See README.
 */
export async function restrictStorageAccess(): Promise<void> {
  for (const area of [chrome.storage.session, chrome.storage.local] as const) {
    try {
      const a = area as chrome.storage.StorageArea & { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> };
      if (typeof a.setAccessLevel === "function") await a.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch {
      /* unsupported for this area; documented residual risk */
    }
  }
}

/** Remove every piece of account-bound data (tokens, captures, cached lookups, extractions, drafts). */
export async function clearAccountData(): Promise<void> {
  // Clear per-tab badges that belong to the account's captures before forgetting them.
  const caps = (await getSession<Record<string, { tabId: number | null }>>("captures").catch(() => undefined)) ?? {};
  for (const r of Object.values(caps)) {
    if (typeof r?.tabId === "number") await chrome.action.setBadgeText({ tabId: r.tabId, text: "" }).catch(() => undefined);
  }
  await chrome.alarms.clear("elevate.poll").catch(() => false);
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
}

/** Simple async mutex: serialises read-modify-write sequences within this service worker. */
export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
