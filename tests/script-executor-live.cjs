const projectRoot = require('node:path').resolve(__dirname, '..')
const output = require('node:path').resolve(
  process.env.COLOOP_SCRIPT_QA_OUTPUT ||
    require('node:path').join(projectRoot, '.qa', 'script-executor-live'),
)
require('node:fs').mkdirSync(output, { recursive: true })
require('esbuild').buildSync({
  entryPoints: [require('node:path').join(projectRoot, 'src/main/infrastructure/task-scripts.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: require('node:path').join(output, 'task-scripts-lib.cjs'),
})
const { TaskScriptExecutor } = require(require('node:path').join(output, 'task-scripts-lib.cjs'))
const path = require('node:path')
const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
;(async () => {
  const root = path.join(output, 'script-jobs')
  const executor = new TaskScriptExecutor(
    root,
    process.env.COLOOP_QA_MODULE_DIRECTORY || path.join(projectRoot, 'node_modules'),
    process.env.COLOOP_QA_NODE_EXECUTABLE || process.execPath,
  )
  const code = String.raw`const {chromium}=require('playwright-core');const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{const result={}; const browser=await chromium.launch({channel:'msedge',headless:false});try{
const page=await browser.newPage();
await page.goto(${JSON.stringify(require('node:url').pathToFileURL(path.join(projectRoot, 'tests/fixtures/web-task-acceptance.html')).href)});
await page.getByRole('textbox',{name:'验收文本'}).fill('COLOOP_SCRIPT_WEB_OK');
await page.getByRole('button',{name:'确认',exact:true}).click();
result.local_form={url:page.url(),actual:await page.locator('#result').innerText()};
await page.screenshot({path:path.join(process.env.COLOOP_TASK_DIRECTORY,'edge-script-form.png')});
try{await page.goto('https://example.com',{waitUntil:'domcontentloaded',timeout:15000});result.public_web={url:page.url(),title:await page.title(),body:await page.locator('body').innerText({timeout:5000})};await page.screenshot({path:path.join(process.env.COLOOP_TASK_DIRECTORY,'edge-example.png')});}catch(error){result.public_web={error:error.message.slice(0,500),url:page.url(),title:await page.title(),body:(await page.locator('body').innerText({timeout:2000})).slice(0,1000)};await page.screenshot({path:path.join(process.env.COLOOP_TASK_DIRECTORY,'edge-example-failure.png')});}
try{await page.goto('https://www.bilibili.com/',{waitUntil:'domcontentloaded',timeout:15000});await page.locator('a[href*="/video/"]').first().waitFor({timeout:10000});result.bilibili={url:page.url(),title:await page.title(),videos:await page.locator('a[href*="/video/"]').evaluateAll(nodes=>Array.from(new Map(nodes.map(a=>[a.href,{title:(a.title||a.innerText||'').trim(),url:a.href}])).values()).filter(a=>a.title).slice(0,5))};await page.screenshot({path:path.join(process.env.COLOOP_TASK_DIRECTORY,'edge-bilibili.png')});}catch(error){result.bilibili={error:error.message.slice(0,500)};}
}finally{await browser.close();await fs.writeFile('web-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}})().catch(error=>{console.error(error);process.exitCode=1;});`
  const verify = String.raw`const result=JSON.parse(require('node:fs').readFileSync('web-results.json','utf8'));console.log(JSON.stringify({verified:result.local_form?.actual==='表单确认：COLOOP_SCRIPT_WEB_OK'&&result.public_web?.title==='Example Domain'&&result.public_web?.body?.includes('documentation')&&result.bilibili?.videos?.length>=3,evidence:JSON.stringify(result)}));`
  const started = Date.now()
  const result = await executor.execute(
    'real-web',
    { execution_id: randomUUID(), runtime: 'node', code, verify_code: verify, timeout_ms: 60000 },
    new AbortController().signal,
  )
  await fs.writeFile(
    path.join(output, 'script-executor-live.json'),
    JSON.stringify({ elapsed_ms: Date.now() - started, ...result }, null, 2),
  )
  console.log(
    JSON.stringify(
      {
        elapsed_ms: Date.now() - started,
        verified: result.verified,
        exit_code: result.exit_code,
        stderr: result.stderr,
        verification_error: result.verification.stderr,
      },
      null,
      2,
    ),
  )
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
