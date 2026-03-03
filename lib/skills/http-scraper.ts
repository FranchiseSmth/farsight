/**
 * http-scraper — 纯 HTTP 网页爬虫，无需 Playwright
 *
 * 策略：
 *  1. fetch + 多 User-Agent 轮换，跟随重定向
 *  2. Readability（Firefox 同款算法）提取正文
 *  3. Readability 失败时降级为 DOM 文本清洗
 *  4. 每批 3 个并行，避免触发限流
 *  5. AbortController 超时保护（12 秒/页）
 */

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import { SkillHandler } from '@/lib/engine/skill-runtime'
import type { Document as ResearchDoc } from '@/types'

// ---------- User-Agent 池 ----------
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
]

function pickUA(url: string): string {
  return USER_AGENTS[url.length % USER_AGENTS.length]
}

// ---------- 原始 HTML 获取 ----------
async function fetchHtml(
  url: string,
  timeoutMs = 12000
): Promise<{ html: string; finalUrl: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': pickUA(url),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        Referer: 'https://www.google.com/',
      },
    })

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

    const ct = res.headers.get('content-type') ?? ''
    if (ct && !ct.includes('html') && !ct.includes('xml') && !ct.includes('text')) {
      throw new Error(`Non-HTML content-type: ${ct.split(';')[0]}`)
    }

    const html = await res.text()
    if (html.trim().length === 0) throw new Error('Empty response body')

    return { html, finalUrl: res.url }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- HTML → 结构化文档 ----------
function parseHtml(html: string, url: string): ResearchDoc {
  const dom = new JSDOM(html, { url })
  const doc = dom.window.document

  // Readability 会修改 DOM，先克隆
  const clone = doc.cloneNode(true) as typeof doc
  const reader = new Readability(clone)
  const article = reader.parse()

  let content: string

  if (article?.textContent && article.textContent.trim().length > 100) {
    // Readability 成功提取正文
    content = article.textContent.replace(/\s+/g, ' ').trim()
  } else {
    // 降级：手动移除噪声标签，取 body 文本
    doc
      .querySelectorAll('script,style,nav,footer,header,aside,noscript,iframe,svg')
      .forEach((el) => el.remove())
    content = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim()
  }

  // 截断超长内容（避免 token 爆炸）
  const MAX_CHARS = 20000
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS) + ' …[截断]'
  }

  return {
    url,
    title: article?.title || doc.title || url,
    content,
    metadata: {
      siteName: article?.siteName ?? new URL(url).hostname,
      byline: article?.byline ?? '',
    },
    word_count: content.split(/\s+/).filter(Boolean).length,
  }
}

// ---------- 单页抓取 ----------
async function scrapeOne(url: string): Promise<ResearchDoc> {
  const { html, finalUrl } = await fetchHtml(url)
  return parseHtml(html, finalUrl)
}

// ---------- Skill 入口 ----------
const httpScraper: SkillHandler = {
  async execute(inputs) {
    const urls = (inputs.urls as string[]).slice(0, 6) // 最多 6 个，避免超时
    const docs: ResearchDoc[] = []
    const errors: string[] = []

    // 每批 3 个并行
    for (let i = 0; i < urls.length; i += 3) {
      const chunk = urls.slice(i, i + 3)
      const settled = await Promise.allSettled(chunk.map(scrapeOne))

      for (let j = 0; j < chunk.length; j++) {
        const r = settled[j]
        const url = chunk[j]
        if (r.status === 'fulfilled') {
          const doc = r.value
          if (doc.word_count > 50) {
            docs.push(doc)
            console.log(`[http-scraper] ✓ ${url} (${doc.word_count} words)`)
          } else {
            console.warn(`[http-scraper] ⚠ ${url} — 内容过少，跳过`)
          }
        } else {
          const msg = (r.reason as Error).message
          errors.push(`${url}: ${msg}`)
          console.warn(`[http-scraper] ✗ ${url} — ${msg}`)
        }
      }
    }

    return {
      documents: docs,
      fetched: docs.length,
      failed: urls.length - docs.length,
      errors,
    }
  },
}

export default httpScraper
