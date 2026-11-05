// electron-builder does not always retain required peers of the Harness SDK.
module.exports = async function afterPack(context) {
  const path = require('node:path')
  const { pathToFileURL } = require('node:url')
  const { repairPackageDependencies } = await import(
    pathToFileURL(path.join(__dirname, 'verify-package-dependencies.mjs')).href
  )
  await repairPackageDependencies(path.join(context.appOutDir, 'resources', 'app'))
}
