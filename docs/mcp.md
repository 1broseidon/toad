# MCP servers

Toad defines MCP servers once under **Settings → Tools → MCP servers**, then grants them per teammate. A teammate sees changes the next time it starts.

## Transports

- Local servers use stdio.
- Remote servers use MCP Streamable HTTP.
- Toad does not advertise the deprecated standalone HTTP+SSE transport. Streamable HTTP may itself use an SSE response stream as defined by MCP.

## HTTP authentication

An HTTP server has one explicit mode:

- **None** sends no credential.
- **Static header** stores the header value in Toad's owner-only MCP credential store. The ordinary app settings contain only the header name.
- **OAuth 2.1** uses Authorization Code with S256 PKCE. Toad follows MCP protected-resource discovery, OAuth authorization-server metadata discovery (including the SDK's OIDC discovery fallback), issuer validation, scopes and RFC 8707 resource indicators. When no client ID is supplied, the advertised RFC 7591 registration endpoint is the primary registration path. A pre-registered public or confidential client can be supplied instead.

Choose **Authorize** beside an OAuth server. Toad opens the authorization page in the desktop's system browser and listens briefly on `127.0.0.1:53682` for the callback. Signing in or creating an account is the authorization site's concern; it is not a Toad account.

Access and rotated refresh tokens, dynamic registration (including expiry), client secrets, PKCE state/verifier and discovery state live in `mcp-auth/credentials.json`, separate from `settings.json` and its backup. On POSIX systems its directory is mode `0700` and the file is mode `0600`. On Windows Toad removes inherited ACEs from the credential directory and grants full control only to the current user SID; credential writes fail closed if that ACL cannot be established. The credential store deliberately has no backup that could retain a rotated or revoked token. Migration reads the live settings and backup independently, writes the private store first, then scrubs both ordinary settings copies. These values are never returned by app-settings RPC. Disconnect attempts RFC 7009 revocation and always removes the local credentials even when the authorization server is unavailable.

The MCP client SDK owns discovery, endpoint and issuer validation, DCR, PKCE, token exchange, refresh and the bounded retry after a 401. Toad owns the credential boundary, explicit browser interaction, callback state comparison and status UI. Authorization URLs and credential values are not logged.

## Desktop and phone

Provisioning is desktop-only in this release. The browser and loopback callback run on the desktop that owns the MCP connection. Phone/web RPC is explicitly denied for authorize, disconnect and credential writes; mobile settings continue to say that tools live on the desktop. A future phone flow needs a deliberate universal/deep-link handoff rather than pretending a phone can reach the desktop's loopback listener.

## Toad Agent and ACP

OAuth HTTP servers attach to the built-in Toad Agent. Its in-process Streamable HTTP transport holds Toad's OAuth provider, so it can refresh and safely retry.

ACP adapters currently receive only MCP URL/header descriptors and cannot consume that provider. Toad therefore withholds OAuth servers from ACP sessions and reports the limitation instead of handing them an expiring bearer token. Uniform ACP support requires a Toad-owned loopback MCP proxy: the adapter authenticates to that local endpoint with an ephemeral per-session credential while Toad owns the upstream OAuth transport and refresh lifecycle.
