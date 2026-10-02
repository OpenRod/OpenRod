/* global __OPENROD_CLOUD_ORIGIN__ */
// Set at build time from OPENROD_CLOUD_ORIGIN; unset keeps every cloud action disabled.
const configured = typeof __OPENROD_CLOUD_ORIGIN__ === 'string' ? __OPENROD_CLOUD_ORIGIN__ : ''
export const CLOUD_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(configured) ? configured : ''
export const CLOUD_AVAILABLE = Boolean(CLOUD_ORIGIN)
export const CLOUD_SOON = "Cloud is coming soon. We're still working on it."
