// Observe synthetic acceptance markers while forwarding to the configured real model.
// Authorization headers are forwarded without logging or persisting them.
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'

export async function startAcceptanceProxy(upstreamBaseUrl, marker, onRecord) {
  const upstream = new URL(upstreamBaseUrl)
  if (upstream.protocol !== 'https:') throw new Error('Expected the configured HTTPS provider')
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const text = body.toString('utf8')
      const position = text.indexOf(marker)
      await onRecord({
        stage: 'host_request',
        at: new Date().toISOString(),
        path: request.url,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        has_canary: position >= 0,
        marker_excerpt:
          position < 0
            ? undefined
            : text.slice(Math.max(0, position - 70), position + marker.length + 70),
      })
      const destination = new URL(request.url, upstream.origin)
      const headers = {
        ...request.headers,
        host: upstream.host,
        'content-length': String(body.length),
      }
      delete headers.connection
      const outgoing = httpsRequest(
        destination,
        { method: request.method, headers },
        (incoming) => {
          void onRecord({
            stage: 'provider_response',
            at: new Date().toISOString(),
            path: request.url,
            status: incoming.statusCode,
            request_has_canary: position >= 0,
          })
          response.writeHead(incoming.statusCode || 502, incoming.headers)
          incoming.pipe(response)
        },
      )
      outgoing.on(
        'finish',
        () =>
          void onRecord({
            stage: 'upstream_request_sent',
            at: new Date().toISOString(),
            path: request.url,
            bytes: body.length,
            has_canary: position >= 0,
          }),
      )
      outgoing.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        response.end('Provider transport failed')
      })
      response.on('close', () => outgoing.destroy())
      outgoing.end(body)
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end('Acceptance proxy failed')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}${upstream.pathname}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
