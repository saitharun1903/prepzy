// Build-time configuration. Values are injected by scripts/build.mjs (esbuild `define`).
// Pages and content scripts can never choose the backend host or request headers.

declare const __ELEVATE_API_BASE__: string;
declare const __ELEVATE_WEB_BASE__: string;
declare const __ELEVATE_CONNECT_ORIGINS__: readonly string[];
declare const __ELEVATE_BUILD_MODE__: string;

export const API_BASE: string = __ELEVATE_API_BASE__;
export const WEB_BASE: string = __ELEVATE_WEB_BASE__;
export const CONNECT_ORIGINS: readonly string[] = __ELEVATE_CONNECT_ORIGINS__;
export const BUILD_MODE: string = __ELEVATE_BUILD_MODE__;
export const CONNECT_PAGE = `${WEB_BASE}/extension/connect`;
