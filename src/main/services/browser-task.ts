/** Host admission only. Planning, context and execution policy belong to the RK Agent. */
export function isBrowserPilot(text: string): boolean {
  if (browserTaskOf(text) === 'video-triple') return true
  return /^(?:请|麻烦|帮我|请帮我|你帮我)?\s*(?:在电脑上)?\s*打开\s*(?:(?:谷歌浏览器|Chrome)[，,\s]*(?:然后)?(?:进入|打开)\s*)?(?:Bilibili|哔哩哔哩|B站)(?:网站|网页)?[。！!\s]*$/i.test(
    text,
  )
}
export function browserTaskOf(text: string): 'home' | 'video-triple' {
  const compact = text.replace(/[，,。！!\s]/g, '').toLowerCase()
  return /^(?:请|帮我|请帮我)?打开(?:bilibili|哔哩哔哩|b站)(?:网站|网页)?(?:点击|点开)(?:主页的)?(?:一个)?(?:任意)?视频(?:然后|再|并)?(?:一键)?三连(?:点赞)?$/.test(
    compact,
  )
    ? 'video-triple'
    : 'home'
}
