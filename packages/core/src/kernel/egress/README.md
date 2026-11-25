# egress

The one place in Tokama that sends data off this machine. Lint allows `fetch` and the network
modules here and in adapters only.

`postGzipJson` posts one JSON text, gzipped (`Content-Encoding: gzip`), and nothing else: the
only headers are `Content-Type` and `Content-Encoding`, with no cookie, no auth and no id. It:

- takes HTTPS URLs only; plain HTTP only to the loopback address, for local test servers;
- refuses a URL with a user name or password;
- refuses a text larger than the caller's limit before anything is sent;
- treats a redirect as a failure and never follows it;
- ends the whole exchange, reply included, after the caller's timeout (on the injected `Clock`);
- reads at most 4 KB of the reply, and counts only a 2xx reply carrying `{ "id": "..." }` as success.

Every failure comes back as a value (`too_large`, `not_allowed`, `timeout`, `network`, `status`,
`bad_reply`). Of the server's own text only a 4xx reply's `{ "error": "..." }` is passed on, as one
line of plain text cut to 200 characters.
