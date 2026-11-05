// A loopback-only business test tenant. It stores real browser submissions and attachments.
// It never reads the model's goal or creates business results on the model's behalf.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  )
const field = (label, name, value = '', type = 'text') =>
  `<label>${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}"></label>`
const area = (label, name, value = '') =>
  `<label>${escape(label)}<textarea name="${escape(name)}" rows="8">${escape(value)}</textarea></label>`
const link = (path, label) => `<a href="${path}">${escape(label)}</a>`
const select = (label, name, options) =>
  `<label>${escape(label)}<select name="${name}">${options.map(([value, text]) => `<option value="${escape(value)}">${escape(text)}</option>`).join('')}</select></label>`
const columns = (records, keys) =>
  `<table><thead><tr>${keys.map((k) => `<th>${escape(k)}</th>`).join('')}</tr></thead><tbody>${records.map((record) => `<tr>${keys.map((k) => `<td>${escape(record[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`

export function businessSeed() {
  return {
    emails: [
      {
        id: 'mail-order-001',
        thread: 'thread-order-001',
        from: 'krystal_567@qq.com',
        subject: 'TEST-202611-001 已付款订单',
        date: '2026-11-05',
        body: '我是林悦。订单 TEST-202611-001，桌面支架3个，单价129.00元，已付款，请周五发出。具体发货时间请确认。',
        attachments: [],
      },
      {
        id: 'mail-old-001',
        thread: 'thread-old-001',
        from: 'old-customer@lab.invalid',
        subject: '旧订单 TEST-202610-099',
        date: '2026-10-03',
        body: '我是另一个林悦，旧订单已完成。请勿修改。',
        attachments: [],
      },
      {
        id: 'mail-unrelated',
        thread: 'thread-unrelated',
        from: 'newsletter@lab.invalid',
        subject: '无关活动简报',
        date: '2026-11-05',
        body: '本邮件与订单无关。',
        attachments: [],
      },
      {
        id: 'mail-meeting-001',
        thread: 'thread-meeting-001',
        from: 'krystal_567@qq.com',
        subject: '测试沟通约会',
        date: '2026-11-05',
        body: '请安排2026年11月12日14:00至15:00线上沟通，时区Asia/Shanghai。如果冲突请先确认其他时段。',
        attachments: [],
      },
    ],
    customers: [
      { id: 'customer-001', name: '林悦', email: 'krystal_567@qq.com' },
      { id: 'customer-002', name: '林悦', email: 'old-customer@lab.invalid' },
    ],
    orders: [
      {
        id: 'existing-order',
        order_id: 'TEST-202610-099',
        customer_id: 'customer-002',
        product: '旧商品',
        quantity: '1',
        unit_price: '80',
        total: '80',
        payment: '已付款',
        shipping: '已完成',
        source_mail: 'mail-old-001',
      },
    ],
    sent: [],
    received: [],
    drafts: [],
    tasks: [],
    expenses: [],
    approvals: [],
    documents: [],
    calendar: [
      {
        id: 'existing-calendar',
        title: '既有测试会议',
        start: '2026-11-12T14:30',
        end: '2026-11-12T15:30',
        timezone: 'Asia/Shanghai',
        attendees: 'existing@lab.invalid',
      },
    ],
    users: [
      { id: 'user-jia', name: '甲', team: '测试团队' },
      { id: 'user-yi', name: '乙', team: '测试团队' },
      { id: 'user-bing', name: '丙', team: '测试团队' },
      { id: 'user-jia-other', name: '甲', team: '其他团队' },
    ],
    products: [
      { id: 'sku-a', name: '有线USB键盘 A', price: 189, seller: '自营', color: '黑色', stock: 8 },
      { id: 'sku-b', name: '有线USB键盘 B', price: 159, seller: '自营', color: '黑色', stock: 5 },
      { id: 'sku-c', name: '有线USB键盘 C', price: 229, seller: '自营', color: '黑色', stock: 9 },
    ],
    cart: [],
    payments: [],
    events: [],
  }
}

export async function startBusinessLab(directory, seed = businessSeed()) {
  directory = resolve(directory)
  await mkdir(directory, { recursive: true })
  const dataPath = join(directory, 'tenant.json')
  let data = await readFile(dataPath, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return structuredClone(seed)
    })
  let journal = Promise.resolve()
  const faultCounts = new Map()
  const persist = async () => {
    const serialized = JSON.stringify(data, null, 2)
    journal = journal.then(async () => {
      const staged = join(directory, `tenant-${randomUUID()}.tmp`)
      await writeFile(staged, serialized)
      await rename(staged, dataPath)
    })
    await journal
  }
  const token = randomUUID()
  const base = `/lab/${token}`
  const url = (path = '') => `${base}${path}`
  const attachmentLinks = (email) =>
    (email.attachments ?? [])
      .filter((a) => !a.inline)
      .map((a, index) => link(url(`/attachment/${email.id}/${index}`), `下载业务附件 ${a.name}`))
      .join(' ')
  const mailDetails = (mail, incoming = true) =>
    `<h2>${escape(mail.subject)}</h2><p>邮件ID ${escape(mail.id)} | 线程 ${escape(mail.thread)} | 日期 ${escape(mail.date)}</p><p>发件人 ${escape(mail.from)} | 收件人 ${escape(mail.to ?? 'coloop-testing@lab.invalid')}</p><pre>${escape(mail.body)}</pre>${attachmentLinks(mail)}${incoming ? link(url(`/compose?reply=${mail.id}`), '回复原线程') : ''}`
  const page = (title, body) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)} · Coloop专用业务测试租户</title><style>body{max-width:1100px;margin:32px auto;font:16px system-ui;line-height:1.6;color:#17212b}nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}a{margin-right:16px}label{display:block;margin:12px 0}input,textarea,select{display:block;width:95%;max-width:800px;padding:8px;font:inherit}button{padding:12px 28px;font:inherit}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:8px;text-align:left}pre{white-space:pre-wrap}small{color:#52616d}</style></head><body><h1>${escape(title)}</h1><small>所有数据均为合成测试资料。邮件只投递到本租户的接收端，外部QQ与飞书未登录。</small><nav>${[
      ['/mail', '收件箱'],
      ['/sent', '已发送'],
      ['/received', '接收端'],
      ['/drafts', '草稿箱'],
      ['/orders', '订单台账'],
      ['/tasks', '团队待办'],
      ['/calendar', '日历'],
      ['/expenses', '报销草稿'],
      ['/documents', '团队文档'],
      ['/products', '商品'],
      ['/cart', '购物车'],
    ]
      .map(([path, label]) => link(url(path), label))
      .join('')}</nav>${body}</body></html>`
  const form = (action, content, button) =>
    `<form method="post" action="${url(action)}" enctype="multipart/form-data">${content}<button>${escape(button)}</button></form>`
  const audit = (operation, value) => {
    data.events.push({ at: new Date().toISOString(), operation, value: structuredClone(value) })
  }
  const server = createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url, 'http://loopback')
      if (!parsed.pathname.startsWith(base + '/')) {
        response.writeHead(404).end('Unknown tenant')
        return
      }
      const path = parsed.pathname.slice(base.length)
      const faults = await readFile(join(directory, 'faults.json'), 'utf8')
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error
          return {}
        })
      const products = data.products.map((product) => ({
        ...product,
        stock: faults.stock?.[product.id] ?? product.stock,
      }))
      const errorKey = `${request.method} ${path}`
      if (path === '/fault/upload-refresh') {
        audit('injected_upload_refresh', { completed_uploads: 2 })
        await persist()
        response.writeHead(200, { 'content-type': 'text/plain' }).end('recorded')
        return
      }
      if (faults.failOnce?.includes(errorKey) && !faultCounts.has(errorKey)) {
        faultCounts.set(errorKey, 1)
        audit('injected_transient_failure', { method: request.method, path })
        await persist()
        response
          .writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            page('临时错误', '<p>本次请求尚未保存，服务暂时不可用，请重新读取实际状态后恢复。</p>'),
          )
        return
      }
      if (request.method === 'POST') {
        if (faults.cutUploadOnce && path === '/mail/send' && !faultCounts.has('cut-upload')) {
          faultCounts.set('cut-upload', 1)
          const declaredBytes = Number(request.headers['content-length'])
          const cutoff = Math.max(1, Math.floor(declaredBytes / 2))
          let consumed = 0
          await new Promise((resolve, reject) => {
            const readPartial = () => {
              let part
              while ((part = request.read(Math.min(4096, cutoff - consumed))) !== null) {
                consumed += part.length
                if (consumed < cutoff) continue
                request.removeListener('readable', readPartial)
                audit('injected_upload_interruption', {
                  bytes_consumed: consumed,
                  declared_bytes: declaredBytes,
                  path,
                })
                persist().then(() => {
                  request.destroy()
                  resolve()
                }, reject)
                return
              }
            }
            request.on('readable', readPartial)
            request.once('error', reject)
          })
          return
        }
        const chunks = []
        let length = 0
        for await (const chunk of request) {
          length += chunk.length
          if (length > 32 * 1024 * 1024) throw new Error('Request too large')
          chunks.push(chunk)
        }
        const fields = await new Request('http://loopback', {
          method: 'POST',
          headers: request.headers,
          body: Buffer.concat(chunks),
        }).formData()
        const values = {}
        const attachments = []
        for (const [name, value] of fields) {
          if (typeof value === 'string') values[name] = value
          else if (value.name && value.size)
            attachments.push({
              name: value.name,
              mime: value.type,
              base64: Buffer.from(await value.arrayBuffer()).toString('base64'),
            })
        }
        let destination
        if (path === '/orders/save') {
          const existing = data.orders.find((order) => order.order_id === values.order_id)
          if (existing) {
            response
              .writeHead(409, { 'content-type': 'text/html; charset=utf-8' })
              .end(page('订单已存在', `<p>${escape(existing.order_id)} 已保存，请读取原记录</p>`))
            return
          }
          const order = { id: randomUUID(), ...values }
          data.orders.push(order)
          destination = '/orders'
        } else if (path === '/mail/send' || path === '/mail/draft') {
          const mail = {
            id: randomUUID(),
            date: new Date().toISOString(),
            from: 'coloop-testing@lab.invalid',
            ...values,
            attachments,
          }
          if (path === '/mail/send') {
            data.sent.push(mail)
            data.received ??= []
            data.received.push({ ...structuredClone(mail), receivedAt: new Date().toISOString() })
            destination = `/sent/${mail.id}`
          } else {
            data.drafts.push(mail)
            destination = `/drafts/${mail.id}`
          }
        } else if (path === '/tasks/save') {
          if (!data.users.some((user) => user.id === values.owner_id))
            throw new Error('Unknown user ID')
          if (data.tasks.some((task) => task.external_id === values.external_id)) {
            response
              .writeHead(409, { 'content-type': 'text/html; charset=utf-8' })
              .end(page('任务已存在', '<p>请返回团队待办核对现有任务</p>'))
            return
          }
          const task = { id: randomUUID(), ...values }
          data.tasks.push(task)
          destination = `/tasks/${task.id}`
        } else if (path === '/calendar/save') {
          const event = { id: randomUUID(), ...values }
          data.calendar.push(event)
          destination = `/calendar/${event.id}`
          const invitation = {
            id: randomUUID(),
            date: new Date().toISOString(),
            from: 'calendar@lab.invalid',
            to: event.attendees,
            subject: `会议邀请 ${event.title}`,
            thread: `calendar-${event.id}`,
            body: `开始 ${event.start}\n结束 ${event.end}\n时区 ${event.timezone}`,
            attachments: [],
            calendar_id: event.id,
          }
          data.sent.push(invitation)
          data.received ??= []
          data.received.push({
            ...structuredClone(invitation),
            receivedAt: new Date().toISOString(),
          })
        } else if (path === '/expenses/save' || path === '/expenses/submit') {
          const expense = { id: randomUUID(), status: '草稿', ...values, attachments }
          if (path === '/expenses/submit') {
            expense.status = '已提交审批'
            data.approvals ??= []
            data.approvals.push(expense.id)
          }
          data.expenses.push(expense)
          destination = `/expenses/${expense.id}`
        } else if (path === '/documents/save') {
          const document = { id: randomUUID(), scope: '测试团队', ...values }
          data.documents.push(document)
          destination = `/documents/${document.id}`
        } else if (path === '/cart/add') {
          const product = products.find((item) => item.id === values.sku)
          if (!product || product.stock < 1) {
            response
              .writeHead(409, { 'content-type': 'text/html; charset=utf-8' })
              .end(page('库存不足', '<p>商品已缺货，请重新比较</p>'))
            return
          }
          data.cart.push({ sku: product.id, quantity: Number(values.quantity) })
          destination = '/cart'
        } else if (path === '/payment/create') {
          data.payments.push({
            id: randomUUID(),
            at: new Date().toISOString(),
            cart: structuredClone(data.cart),
          })
          destination = '/cart'
        } else {
          response.writeHead(404).end()
          return
        }
        audit(path, {
          ...values,
          attachments: attachments.map(({ name, base64 }) => ({
            name,
            bytes: Buffer.from(base64, 'base64').length,
          })),
        })
        await persist()
        const responseDelay =
          faults.responseDelayMs?.[path] ?? (path === '/mail/send' ? faults.sendResponseDelayMs : 0)
        if (responseDelay)
          await new Promise((resolve) => setTimeout(resolve, Math.min(30000, responseDelay)))
        response.writeHead(303, { location: url(destination) }).end()
        return
      }
      const mailId = path.startsWith('/mail/') ? path.slice('/mail/'.length) : undefined
      const mail = data.emails.find((item) => item.id === mailId)
      let title = '测试租户',
        body = ''
      if (path === '/mail') {
        title = '收件箱'
        body = data.emails
          .map(
            (mail) => `<p>${link(url(`/mail/${mail.id}`), `${mail.subject} · ${mail.from}`)}</p>`,
          )
          .join('')
      } else if (mail) {
        title = '邮件详情'
        body = mailDetails(mail)
      } else if (path === '/compose') {
        title = '撰写测试邮件'
        const original = data.emails.find((mail) => mail.id === parsed.searchParams.get('reply'))
        const content =
          field('收件人', 'to', original?.from ?? '') +
          field('主题', 'subject', original ? `Re: ${original.subject}` : '') +
          field('线程标识', 'thread', original?.thread ?? '') +
          area('正文', 'body') +
          field('业务附件', 'attachment', '', 'file')
        body = `<form method="post" action="${url('/mail/send')}" enctype="multipart/form-data">${content}<button>发送测试邮件</button><button formaction="${url('/mail/draft')}">保存草稿</button></form>`
      } else if (['/sent', '/received', '/drafts'].includes(path)) {
        title = path === '/sent' ? '已发送' : path === '/received' ? '接收端收件箱' : '草稿箱'
        const collection =
          path === '/drafts'
            ? data.drafts
            : path === '/received'
              ? (data.received ?? [])
              : data.sent
        body =
          collection
            .map(
              (mail) =>
                `<p>${link(url(`${path}/${mail.id}`), `${mail.subject} · ${mail.to} · ${mail.id}`)}</p>`,
            )
            .join('') || '<p>暂无邮件</p>'
        body += link(url('/compose'), '新建邮件')
      } else if (/^\/(sent|received|drafts)\//.test(path)) {
        title = path.startsWith('/drafts')
          ? '已保存草稿'
          : path.startsWith('/received')
            ? '接收端邮件'
            : '发送完成'
        const id = path.split('/')[2]
        const collection = path.startsWith('/received')
          ? (data.received ?? [])
          : [...data.sent, ...data.drafts]
        const mail = collection.find((mail) => mail.id === id)
        if (!mail) {
          response.writeHead(404).end()
          return
        }
        body = mailDetails(mail, false)
      } else if (path.startsWith('/attachment/')) {
        const [, , mailId, index] = path.split('/')
        const mail = [...data.emails, ...data.sent, ...data.drafts].find(
          (mail) => mail.id === mailId,
        )
        const attachment = mail?.attachments?.filter((a) => !a.inline)[Number(index)]
        if (!attachment) {
          response.writeHead(404).end()
          return
        }
        const downloadNumber = (faultCounts.get('attachment_downloads') ?? 0) + 1
        faultCounts.set('attachment_downloads', downloadNumber)
        if (downloadNumber === faults.cutDownloadOnceAt) {
          const bytes = Buffer.from(attachment.base64, 'base64')
          audit('injected_download_interruption', {
            mail_id: mailId,
            name: attachment.name,
            download_number: downloadNumber,
          })
          await persist()
          response.writeHead(200, {
            'content-type': attachment.mime || 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
            'content-length': bytes.length,
          })
          response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))))
          setTimeout(() => response.destroy(), 20)
          return
        }
        response
          .writeHead(200, {
            'content-type': attachment.mime || 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          })
          .end(Buffer.from(attachment.base64, 'base64'))
        return
      } else if (path === '/orders') {
        title = '订单台账'
        body =
          columns(data.orders, [
            'order_id',
            'customer_id',
            'product',
            'quantity',
            'unit_price',
            'total',
            'payment',
            'shipping',
            'source_mail',
          ]) + link(url('/orders/new'), '新建订单')
      } else if (path === '/orders/new') {
        title = '新建订单'
        body = form(
          '/orders/save',
          field('订单号', 'order_id') +
            select(
              '客户（用户ID及邮箱）',
              'customer_id',
              data.customers.map((customer) => [
                customer.id,
                `${customer.name} | ${customer.id} | ${customer.email}`,
              ]),
            ) +
            ['商品', '数量', '单价', '总价', '付款状态', '发货要求', '来源邮件标识']
              .map((label, index) =>
                field(
                  label,
                  [
                    'product',
                    'quantity',
                    'unit_price',
                    'total',
                    'payment',
                    'shipping',
                    'source_mail',
                  ][index],
                ),
              )
              .join(''),
          '保存订单',
        )
      } else if (path === '/tasks') {
        title = '团队待办'
        body =
          data.tasks
            .map(
              (task) =>
                `<p>${link(url(`/tasks/${task.id}`), `${task.title} | ${task.owner_id} | ${task.due || '待确认'} | ${task.external_id}`)}</p>`,
            )
            .join('') + link(url('/tasks/new'), '新建团队任务')
      } else if (path === '/tasks/new') {
        title = '新建团队任务'
        body = form(
          '/tasks/save',
          field('任务标识', 'external_id') +
            field('任务标题', 'title') +
            select(
              '负责人ID',
              'owner_id',
              data.users.map((user) => [user.id, `${user.name} | ${user.team} | ${user.id}`]),
            ) +
            field('截止日期（待定留空）', 'due', '', 'date') +
            area('任务说明', 'body'),
          '保存任务',
        )
      } else if (path.startsWith('/tasks/')) {
        const task = data.tasks.find((item) => item.id === path.split('/')[2])
        title = '团队任务已保存'
        body = task
          ? columns([task], ['external_id', 'title', 'owner_id', 'due', 'body'])
          : '<p>任务不存在</p>'
      } else if (path === '/calendar') {
        title = '日历'
        body =
          columns(data.calendar, ['id', 'title', 'start', 'end', 'timezone', 'attendees']) +
          link(url('/calendar/new'), '创建会议邀请')
      } else if (path === '/calendar/new') {
        title = '创建会议邀请'
        body = form(
          '/calendar/save',
          field('会议主题', 'title') +
            field('开始时间', 'start', '', 'datetime-local') +
            field('结束时间', 'end', '', 'datetime-local') +
            field('时区', 'timezone', 'Asia/Shanghai') +
            field('参与人邮箱', 'attendees'),
          '保存并发送测试邀请',
        )
      } else if (path.startsWith('/calendar/')) {
        title = '会议邀请已保存'
        const event = data.calendar.find((item) => item.id === path.split('/')[2])
        body = columns(event ? [event] : [], [
          'id',
          'title',
          'start',
          'end',
          'timezone',
          'attendees',
        ])
      } else if (path === '/expenses') {
        title = '报销草稿'
        body =
          data.expenses
            .map(
              (expense) =>
                `<p>${link(url(`/expenses/${expense.id}`), `${expense.title} | ${expense.total} | ${expense.status}`)}</p>`,
            )
            .join('') + link(url('/expenses/new'), '新建报销草稿')
      } else if (path === '/expenses/new') {
        title = '新建报销草稿'
        body = form(
          '/expenses/save',
          field('报销标题', 'title') +
            field('可报销合计', 'total') +
            area('票据明细与待补信息', 'body') +
            [1, 2, 3].map((i) => field(`票据附件${i}`, `attachment${i}`, '', 'file')).join(''),
          '保存报销草稿',
        ).replace(
          '</form>',
          `<button formaction="${url('/expenses/submit')}">提交审批</button></form>`,
        )
        if (faults.refreshAfterUploads === 2)
          body += `<script>
          let uploads = 0;
          for (const input of document.querySelectorAll('input[type=file]')) {
            input.addEventListener('change', async () => {
              uploads++;
              if (uploads === 2 && !sessionStorage.getItem('upload-refresh-injected')) {
                sessionStorage.setItem('upload-refresh-injected','yes');
                await fetch('${url('/fault/upload-refresh')}');
                location.reload();
              }
            });
          }
        </script>`
      } else if (path.startsWith('/expenses/')) {
        title = '报销草稿已保存'
        const expense = data.expenses.find((item) => item.id === path.split('/')[2])
        body = expense
          ? columns([expense], ['title', 'total', 'status', 'body']) +
            `<p>附件 ${expense.attachments.map((a) => escape(a.name)).join('、')}</p>`
          : '<p>不存在</p>'
      } else if (path === '/documents') {
        title = '测试团队文档文件夹'
        body =
          data.documents
            .map(
              (document) =>
                `<p>${link(url(`/documents/${document.id}`), `${document.title} | ${document.scope}`)}</p>`,
            )
            .join('') + link(url('/documents/new'), '新建团队文档')
      } else if (path === '/documents/new') {
        title = '新建团队文档'
        body = form(
          '/documents/save',
          field('文档标题', 'title') + area('文档正文', 'body'),
          '保存到测试团队',
        )
      } else if (path.startsWith('/documents/')) {
        title = '团队文档已保存'
        const document = data.documents.find((item) => item.id === path.split('/')[2])
        body = document
          ? `<h2>${escape(document.title)}</h2><p>权限 ${escape(document.scope)}</p><pre>${escape(document.body)}</pre>`
          : '<p>不存在</p>'
      } else if (path === '/products') {
        title = '测试商品候选'
        body = products
          .map(
            (product) =>
              `<p>${link(url(`/products/${product.id}`), `${product.name} | ¥${product.price} | ${product.seller} | ${product.color} | 库存${product.stock}`)}</p>`,
          )
          .join('')
      } else if (path.startsWith('/products/')) {
        const product = products.find((item) => item.id === path.split('/')[2])
        title = '商品详情'
        body = product
          ? columns([product], ['id', 'name', 'price', 'seller', 'color', 'stock']) +
            form(
              '/cart/add',
              field('SKU', 'sku', product.id) + field('数量', 'quantity', '1', 'number'),
              '加入测试购物车',
            )
          : '<p>商品不存在</p>'
      } else if (path === '/cart') {
        title = '购物车'
        body =
          columns(data.cart, ['sku', 'quantity']) +
          `<p>购物车件数 ${data.cart.reduce((sum, item) => sum + item.quantity, 0)} | 支付笔数 ${data.payments.length}</p>` +
          link(url('/checkout'), '进入结算')
      } else if (path === '/checkout') {
        title = '测试结算'
        body =
          columns(data.cart, ['sku', 'quantity']) +
          form('/payment/create', '', '下单并支付（仅测试记录）')
      } else {
        response.writeHead(404).end()
        return
      }
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(page(title, body))
    } catch (error) {
      if (!response.headersSent)
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`测试租户处理失败 ${escape(error.message)}`)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  await persist()
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}${base}`,
    snapshot: () => structuredClone(data),
    close: async () => {
      await journal
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Supply a test tenant data directory')
  const seed = process.argv[3]
    ? JSON.parse(await readFile(process.argv[3], 'utf8'))
    : businessSeed()
  const lab = await startBusinessLab(directory, seed)
  await writeFile(
    join(resolve(directory), 'connection.json'),
    JSON.stringify({ baseUrl: lab.baseUrl, startedAt: new Date().toISOString() }, null, 2),
  )
  console.log(JSON.stringify({ baseUrl: lab.baseUrl, directory: resolve(directory) }))
  const stop = async () => {
    await lab.close()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
