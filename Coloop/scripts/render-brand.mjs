/** Rasterize the canonical vector in Chromium; no separately drawn icon geometry. */
import { _electron as electron } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
await mkdir(resolve(root, '.qa'), { recursive: true })
const app = await electron.launch({
  args: [
    resolve(root, 'scripts/brand-renderer.cjs'),
    `--user-data-dir=${resolve(root, '.qa/brand-profile')}`,
  ],
  cwd: root,
})
try {
  const page = await app.firstWindow()
  const svg = await readFile(resolve(root, 'resources/brand.svg'), 'utf8')
  const brandBackground = svg.match(/<rect[^>]*fill="([^"]+)"/)?.[1]
  if (!brandBackground) throw new Error('Canonical logo background is missing')
  const inverse = svg
    .replaceAll(brandBackground, '__BRAND_BACKGROUND__')
    .replaceAll('#FFFFFF', brandBackground)
    .replaceAll('__BRAND_BACKGROUND__', '#FFFFFF')
  await writeFile(resolve(root, 'resources/brand-inverse.svg'), inverse)
  const font = (await readFile(resolve(root, 'resources/fonts/Sora-Variable.ttf'))).toString(
    'base64',
  )
  await page.setViewportSize({ width: 512, height: 512 })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:512px;height:512px}</style>${svg}`,
  )
  await page.screenshot({ path: resolve(root, 'resources/icon.png'), omitBackground: true })
  await page.setViewportSize({ width: 1440, height: 720 })
  await page.setContent(`
    <style>
      @font-face{font-family:Sora;src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:100 800;font-display:block}
      *{box-sizing:border-box}body{margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#ffffff;color:${brandBackground}}
      .board{height:720px;display:grid;grid-template-columns:1.7fr 1fr}
      .identity{background:${brandBackground};padding:88px 80px;display:flex;flex-direction:column;justify-content:center;color:#ffffff}
      .lockup{display:flex;gap:28px;align-items:center}.lockup svg{width:134px;height:134px;flex-shrink:0}
      h1{font-family:Sora,sans-serif;font-size:80px;font-weight:600;letter-spacing:-3px;margin:0;line-height:1.1}
      .identity p{font-size:22px;color:#bdbdbd;margin:42px 0 0;letter-spacing:2px}
      .detail{padding:72px 60px;display:flex;flex-direction:column;justify-content:space-between}
      .detail h2{font-size:16px;font-weight:500;margin:0;color:#666666}.sizes{display:flex;align-items:center;gap:36px;margin-top:30px}
      .sizes svg{display:block}.mono{background:#ededed;border-radius:14px;padding:30px;display:flex;align-items:center;gap:24px}
      .mono svg{width:54px;height:54px}.mono span{font-family:Sora,sans-serif;font-size:30px;font-weight:600;letter-spacing:-1px}
      .palette{display:flex;gap:10px;margin-top:24px}.swatch{width:64px;height:12px;border-radius:3px}
      small{display:block;color:#666666;font-size:12px;margin-top:18px}
    </style>
    <div class="board">
      <div class="identity"><div class="lockup">${svg}<h1>Coloop</h1></div><p>连接屏幕、模型与设备</p></div>
      <div class="detail"><div><h2>让信息形成回路。</h2><div class="sizes">${svg.replace('width="128" height="128"', 'width="96" height="96"')}${svg.replace('width="128" height="128"', 'width="48" height="48"')}${svg.replace('width="128" height="128"', 'width="24" height="24"')}</div></div>
      <div class="mono">${inverse}<span>Coloop</span></div>
      <div><h2>Coloop / 桌面智能工作台</h2><div class="palette"><i class="swatch" style="background:${brandBackground}"></i><i class="swatch" style="background:#ffffff"></i><i class="swatch" style="background:#bdbdbd"></i></div><small>SVG 源文件 · PNG 512px · Windows ICO</small></div></div>
    </div>`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: resolve(root, 'resources/logo-preview.png') })
  console.log('Canonical SVG rendered to icon.png and logo-preview.png')
} finally {
  await app.close()
}
