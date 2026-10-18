# Desktop LAN companion protocol

The service is off at every desktop launch. Settings must explicitly enable it,
select source and target folders, and create a one-use pairing setup. Closing the
service stops network access; revoking devices invalidates all existing tokens.
The service only accepts private/link-local/loopback peers, never an arbitrary
remote filesystem path, shell command, upload, or source deletion operation.

## TLS and pairing

Settings exports JSON `{version:1,url,fingerprint,pairingCode,expiresAt}`. The URL
uses HTTPS and a selected private IPv4 address. `expiresAt` is Unix milliseconds;
setup expires within two minutes and the latest setup replaces the previous one.
`fingerprint` is SHA256 of the **complete leaf certificate DER**, 64 lowercase hex
characters. Normalize colon-separated fingerprints by removing colons and
lowercasing. Native clients must compare this pin before sending a pairing code or
bearer token, on every TLS connection. This self-signed certificate has a fixed
identity and no IP hostname SAN: the leaf pin is the connection trust authority.
Do not accept a certificate merely because a hostname check was disabled.

The locally generated RSA key and certificate live in the user-data directory,
with owner-only filesystem modes where supported. No external OpenSSL executable
or added runtime dependency is required. Authentication tokens are returned once
and only SHA256 token hashes are persisted. Pairing secrets never enter logs.
The server limits clients, roots, receipts, connections, body/header size, request
time, and pairing attempts. There is no browser CORS access.

## API v1

All JSON responses are `{version:1,ok:true,data}` or
`{version:1,ok:false,error:{code}}`. Errors contain no paths or stacks.
All routes except pairing require `Authorization: Bearer <token>`. POST requests
require exact `Content-Type: application/json` and reject unknown fields.

- `POST /api/v1/pair`: `{pairingCode,deviceName}` -> `{clientId,token}`.
- `GET /api/v1/roots`: `[{id,label,role:'source'|'target'}]`.
- `GET /api/v1/snapshot`: `{jobs,projects}`. Re-fetch after reconnect and poll for
  ongoing progress. Jobs contain `id,name,mode,state,totalFiles,totalBytes,
  filesDone,filesFailed,bytesDone,sourceRootId,targetRootIds`. Projects contain
  `id,name`. No desktop absolute paths are included in snapshots.
- `GET /api/v1/projects`: full desktop `ParentProject[]` with `id,name,details,
  createdAt,updatedAt`. Details contain `projectName,shootDay,camera,lenses,notes,crew`.
- `POST /api/v1/projects`: `{requestId,id?,name?,details?}`. Absent `id` creates a
  parent project and requires `name`; present `id` updates the project. `details`
  is a partial details object; omitted fields, crew and lenses are preserved.
- `GET /api/v1/jobs/:id/project`: desktop `ProjectInfo`, with details plus
  `cardLabel,copyNotes,parentProjectName,updatedAt`.
- `POST /api/v1/jobs/:id/project`: `{requestId,project}` with partial `ProjectDraft`
  fields. Omitted fields and parent association metadata are preserved; the server
  sets `updatedAt`. Updating metadata never rewrites old report revisions.
- `POST /api/v1/jobs`: `{requestId,name?,sourceRootId,targetRootIds,mode,hashAlgorithm,
  manifestFormat,projectName}` -> job. One or two targets. Seven desktop hash
  algorithms and four manifest formats retain the desktop compatibility matrix.
  `name` preserves the task/card label separately from project metadata; older clients may omit it.
  Remote jobs always use independent reread verification and disable proxies.
- `POST /api/v1/jobs/:id/start|pause|resume|cancel`: `{requestId}` -> job.
  Start requires `draft`; pause requires `queued|running`; resume requires
  `paused`; cancel requires a nonterminal state. Completed reports cannot be
  invalidated by remotely restarting/cancelling a terminal job.
- `GET /api/v1/reports/:jobId`: `[{revision,createdAt,formats}]`.
- `GET /api/v1/reports/:jobId/:revision/json|html|pdf`: existing immutable binary
  report. There is no report generation/edit route. Only terminal jobs with no
  active engine may expose reports. Files must belong to the local report archive.

## Authorization and retries

Folder IDs refer to exact folders selected on the desktop. Role, canonical path,
device and inode must still match at access time. Missing or replaced folders
lose authority. A job is visible/controllable only when its source and all its
targets match currently approved roles. All operations use the existing desktop
JobManager and Store; the network service never copies source media itself.

A `requestId` must be unique per paired client across mutation routes, 6–100 ASCII
letters, digits, underscores or hyphens. Replaying an identical mutation returns
its persisted result; changing its payload or route gives `request_conflict`.
Concurrent retries are serialized. A durable reservation precedes engine work.
If the desktop exits during the operation, retries receive `request_uncertain`;
reconnect and inspect the snapshot before taking another action. The server never
replays an uncertain operation and never evicts successful receipts to make room.
The 4096-receipt limit fails closed. Desktop recovery remains authoritative for
jobs interrupted by a desktop restart.

## Beta verification limits

Host tests use actual TLS sockets, certificate fingerprints, revoked/expired
pairing, malformed input, traversal/role rejection, concurrent retry requests,
fresh authority reopen, actual Store/JobManager read-only verification and
immutable report revisions. Physical mobile devices, changing network interfaces,
Windows filesystem ACLs, and mobile pinning implementation still require their
platform acceptance tests. Desktop Settings displays the short-lived setup as a QR code and also provides copyable JSON fallback; a phone camera must still pass real-device optical acceptance.
