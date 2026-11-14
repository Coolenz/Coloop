// electron-builder does not always retain required peers of the Harness SDK.
module.exports = async function afterPack(context) {
  const path = require('node:path')
  const { pathToFileURL } = require('node:url')
  const { repairPackageDependencies } = await import(
    pathToFileURL(path.join(__dirname, 'verify-package-dependencies.mjs')).href
  )
  await repairPackageDependencies(path.join(context.appOutDir, 'resources', 'app'))
  const fs = require('node:fs/promises')
  const crypto = require('node:crypto')
  const resources = path.join(context.appOutDir, 'resources')
  await fs.access(path.join(resources, 'icon.ico'))
  await fs.access(path.join(resources, 'auto-agent-work-hook.mjs'))
  await fs.access(path.join(resources, 'cli', 'coloop-cli.mjs'))
  await fs.access(path.join(resources, 'cli', 'with-workspace-cache.mjs'))
  await fs.access(path.join(resources, 'harness', 'coloop-playwright.mjs'))
  await fs.access(path.join(resources, 'harness', 'coloop-scheduler.mjs'))
  const uia = path.join(resources, 'auto-work-uia')
  const manifest = JSON.parse(
    (await fs.readFile(path.join(uia, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''),
  )
  for (const file of [
    'Coloop.AutoWork.Uia.exe',
    'FlaUI.Core.dll',
    'FlaUI.UIA3.dll',
    'Interop.UIAutomationClient.dll',
  ]) {
    const expected = manifest.find((entry) => entry.file === file)?.sha256?.toLowerCase()
    const actual = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(uia, file)))
      .digest('hex')
    if (!expected || actual !== expected)
      throw new Error(`Packaged Auto Work UIA integrity failed: ${file}`)
  }
}
