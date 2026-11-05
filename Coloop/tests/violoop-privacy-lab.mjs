// Loopback-only provider substitute for synthetic privacy acceptance data.
import { createServer } from 'node:http'
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const directory = resolve(process.argv[2])
await mkdir(directory, { recursive: true })
let faultInjected = false
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const body = JSON.parse(bytes.toString('utf8'))
    const faults = await readFile(join(directory, 'faults.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => ({}))
    const fail = faults.failOnce && !faultInjected
    faultInjected ||= !!fail
    await appendFile(
      join(directory, 'requests.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        path: request.url,
        bytes: bytes.length,
        has_authorization: !!request.headers.authorization,
        body,
        status: fail ? 503 : 200,
      }) + '\n',
    )
    if (fail) {
      response
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'Synthetic temporary outage' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'synthetic-privacy-analysis',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: '核对真实订单字段后登记，保持其他来源原样。',
                steps: ['读取实际来源及已批准字段。', '登记台账并核对金额。', '独立读回产物核验。'],
                uncertainties: [],
              }),
            },
          },
        ],
      }),
    )
  } catch {
    response.writeHead(400).end('Invalid test request')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, directory }
await writeFile(join(directory, 'endpoint.json'), JSON.stringify(endpoint, null, 2))
console.log(JSON.stringify(endpoint))
