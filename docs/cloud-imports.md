# OpenRod Cloud configuration imports

The configuration importer copies reviewed resources between explicit gateway/workspace locations. It does not move the source or replace running processes. The same API serves local, connected-host, and OpenRod Cloud destinations; authentication, account ownership, and destination selection remain enforced by the existing console/cloud transport.

A deployed, authenticated Cloud worker is required to import into Cloud. Passing local tests does not establish that Cloud is deployed or that a live cloud sandbox can be created.

Open **Connections → OpenRod Cloud → Import data** in local OpenRod. A successful new connection also offers an optional import step; **Not now** keeps the connection without copying anything. Choose all categories or import one category at a time.

## Supported resources

| Type | Behavior |
| --- | --- |
| Groups | Copies definitions under destination IDs. Sandbox memberships are excluded. Pinned base policies, including customized built-ins and their access additions, are materialized as separate destination policies and the group pin is remapped. Existing destination base policies are unchanged. |
| Network | Copies group/setup rules and remaps their targets. Source organization blocks become required block rules scoped to imported groups; the destination organization is not changed. Legacy global or sandbox-specific rules require manual review and are excluded. Private address rules receive a compatibility warning. |
| MCP & Skills | Copies saved MCP definitions and reviewed text skill files. Package artifacts are prepared on the destination rather than copied. Source provider references and all environment/header values are removed. Credentials must be reconnected. ZIP/binary skill files are excluded with warnings. |
| Templates | Copies image references or rebuilds recipes on the destination. Environment values are excluded. Required npm MCP packages are prepared through the existing preparation service; the built template references the prepared snapshots, whose source setup relationship is retained. Unresolved credential/configuration requirements stop the dependent template with a retryable result. |
| Activity | Explicit opt-in; copies up to 500 normalized events per page with original timestamps and source gateway/workspace/event identity. Raw payloads are excluded and detected credential material is redacted. Overlapping imports and retries deduplicate by source identity. |
| Secrets | Not exported by configuration import. Reconnect or add credentials on the destination. |
| Sandbox files | Use the separate **Copy workspace** flow on a running sandbox. Configuration import does not transfer workspace files. |

## Local agent configuration

Configuration export reads **saved OpenRod setups**, not arbitrary host files. To transfer existing Claude, Codex, or Cursor configuration:

1. On the source, use MCP & Skills → Bring my setup.
2. Discover and review the specific MCPs/skills, prepare supported packages as appropriate, and save the setup.
3. Select that setup in the configuration importer, review exclusions, and copy it to the destination.
4. Reconnect required credentials there. Templates with unresolved setup requirements report a partial import rather than claiming the template is ready.

Source paths are never submitted to the destination importer for filesystem discovery. Package installation uses the existing isolated preparation service.

## API contract

All endpoints use `/api/os/resource-imports`. Local mutations require the existing same-origin/custom-header checks. Cloud calls use the authenticated, owner-bound cloud transport. Every import is stored in the request's gateway/workspace scope.

- `GET /capabilities`: supported types and limits. Activity is supported only when that location's activity store is available.
- `POST /export`: `{ types?, selection?, activity? }`; returns a versioned bundle, source identity, portable resources, explicit exclusions, and optional activity pagination information. `selection` contains resource keys such as `groups:development`. Dependencies and source organization restrictions are included automatically. Internal `policyTemplates` resources represent materialized group base policies; they are dependencies rather than a separate top-level category.
- `POST /plan`: `{ bundle, selection?, conflicts? }`; validates and persists a plan without creating destination resources. Dependencies are expanded and destination identities are fixed. Conflicts default to creating a separate copy; explicit reuse requires identical compatible content.
- `POST /:id/execute`: `{ acknowledged: true }`; starts the reviewed plan and returns its job view.
- `GET /:id`: persistent job status and per-resource results.
- `GET /`: latest 100 persisted jobs for this destination.
- `POST /:id/retry`: `{ acknowledged: true }`; retries incomplete items and retains completed results.
- `POST /:id/cancel`: `{}`; requests cancellation at the next safe boundary. Already-created resources remain visible in the results.

Example conflict choice:

```json
{
  "conflicts": {
    "groups:development": {
      "action": "reuse",
      "targetId": "development"
    }
  }
}
```

The importer never resolves conflicts by name alone and does not expose an implicit replacement operation. Reused resources are checked again before execution.

## Activity pagination

Activity is excluded from default exports. Request it explicitly:

```json
{
  "types": ["activity"],
  "activity": {
    "from": "2026-10-01T00:00:00Z",
    "to": "2026-10-07T00:00:00Z",
    "offset": 0
  }
}
```

Dates are optional. Without dates the first page contains the latest retained events. The response includes:

```json
{
  "pages": {
    "activity": {
      "snapshot": 1250,
      "offset": 0,
      "total": 1250,
      "exported": 500,
      "nextOffset": 500
    }
  }
}
```

For the next page, keep the same dates and `snapshot`, and pass `offset: nextOffset`. Continue until `nextOffset` is `null`. Each page is a separately reviewed import batch. If source logs are deleted during pagination, restart the export; deduplication makes repeated events safe.

Imported activity is historical evidence from its recorded source. It does not claim that those actions occurred on the destination. Management events record import start, retry, and final outcomes separately.

## Limits and recovery

- Configuration request/bundle: **8 MiB**.
- Resources per configuration bundle: **500**.
- Concurrent running imports per destination: **2**.
- Activity events per batch: **500**.
- Text skill: **200 files / 4 MiB**, with each text file limited to 512 KiB.
- Existing workspace copy: **25 MiB / 2,000 files**, with a 36 MiB encoded request limit. It excludes `.git`, caches/dependencies, credential files, agent configuration directories, symlinks, and other unsupported paths. It is not a resumable full filesystem migration.

Job files live under the destination's scoped console data directory at `resource-imports/<job-id>.json`, with private directory/file permissions. They contain sanitized configurations and progress, not source credentials. Setup publication is atomic and exclusive.

A restarted server exposes unfinished jobs as `interrupted`. Retry checks destination identities/content before creating anything again. A template still building must finish or be inspected before retry. Failed new template build entries can be dismissed by the importer before rebuilding; published templates are never silently overwritten.

Cancellation does not roll back completed resources. Long build/preparation cancellation follows the underlying service's safe boundary. Remove unwanted partial resources through their normal destination pages after reviewing the job. Persistent import jobs currently have no automatic retention cleanup; include the scoped console data directory and activity SQLite archive in operational backup/retention planning.

## Validation

The automated importer suite exercises actual scoped storage and policy routes with a mocked gateway transport, plus real SQLite history storage. It covers dependency remapping, organization restrictions, credential removal, unsafe skill paths/content, explicit conflict checks, partial retries, interruption reconciliation, concurrent starts, cancellation, history pagination/provenance/deduplication, and prepared template dependencies.

Run from the repository root:

```sh
node --test ui/server/resource-imports.test.js ui/server/resource-imports.integration.test.js
```

A release still requires live destination verification: authenticated Cloud provisioning, a real cloud sandbox, actual template builds/package preparation, local-to-Cloud and connected-host-to-Cloud imports, terminal/files, and account isolation across the full deployed transport.
