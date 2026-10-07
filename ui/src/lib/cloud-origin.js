/* global __OPENROD_CLOUD_ORIGIN__ */
import { DEFAULT_CLOUD_ORIGIN } from '../../shared/cloud-origin.js'

// The build can override or disable the hosted endpoint; runtime status is authoritative.
const configured = (typeof __OPENROD_CLOUD_ORIGIN__ === 'string' ? __OPENROD_CLOUD_ORIGIN__ : DEFAULT_CLOUD_ORIGIN).trim()
export const CLOUD_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(configured) ? configured : ''
export const CLOUD_AVAILABLE = Boolean(CLOUD_ORIGIN)
export const CLOUD_SOON = "Cloud is coming soon. We're still working on it."
