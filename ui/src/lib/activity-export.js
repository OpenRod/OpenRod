// Pinned contract: https://github.com/ocsf/ocsf-schema/tree/v1.4.0
// Base Event is deliberately used: shorthand lacks the evidence required to
// faithfully populate specialized network/process/authentication classes.
export const OCSF_VERSION = '1.4.0'
export function toOCSF(event) {
  const sourceTime = Date.parse(event.at)
  const receivedTime = Date.parse(event.receivedAt)
  if (!Number.isFinite(sourceTime) && !Number.isFinite(receivedTime)) throw new Error('OCSF export requires an event or collection timestamp')
  const severity = { INFO: 1, INFORMATIONAL: 1, LOW: 2, MED: 3, MEDIUM: 3, HIGH: 4, CRITICAL: 5, FATAL: 6 }[String(event.severity).toUpperCase()] ?? 0
  const action = event.action || event.method
  return {
    category_uid: 0, class_uid: 0, activity_id: action ? 99 : 0, type_uid: action ? 99 : 0,
    ...(action ? { activity_name: action } : {}),
    severity_id: severity,
    time: Number.isFinite(sourceTime) ? sourceTime : receivedTime,
    metadata: {
      version: OCSF_VERSION,
      product: { name: 'OpenShell Console', vendor_name: 'OpenShell' },
      ...(event.id ? { uid: event.id } : {}),
      ...(Number.isFinite(receivedTime) ? { logged_time: receivedTime } : {}),
      ...(event.correlationId ? { correlation_uid: event.correlationId } : {}),
    },
    ...(event.message ? { message: event.message } : {}),
    status_id: event.outcome === 'success' ? 1 : event.outcome === 'failure' ? 2 : 0,
    raw_data: JSON.stringify(event.original ?? event),
    unmapped: { openshell: event, time_basis: Number.isFinite(sourceTime) ? 'source_event' : 'collection_time; source timestamp unavailable' },
  }
}
export function exportDocument(events, context, format = 'json') {
  if (format === 'ocsf') return events.map(toOCSF)
  return { exportedAt: new Date().toISOString(), context, events }
}
