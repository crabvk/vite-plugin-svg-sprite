import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { watch } from 'chokidar'
import { optimize, type Config as SvgoConfig } from 'svgo'
import type { Plugin, ResolvedConfig } from 'vite'

interface PluginOptions {
  include: string | string[]
  symbolId?: string
  inject?: 'body-last' | 'body-first'
  svgoConfig?: SvgoConfig
  fileName?: string
  attributes?: Record<string, string>
}

const CWD = process.cwd()
const VIRTUAL_MODULE_ID = 'virtual:svg-sprite'
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`
const DEFAULT_SYMBOL_ID = '[dir]-[name]'
const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_SVGO_CONFIG: SvgoConfig = {
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          // Keep the original SVG structure.
          mergePaths: false,
          // Force to remove legal comments.
          removeComments: {
            preservePatterns: false,
          },
        },
      },
    },
    'removeXMLNS',
  ],
}

const getHash = (content: string) =>
  createHash('md5')
    .update(content)
    .digest('base64')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .slice(0, 8)

class SvgSprite {
  #dom: JSDOM
  #content: string
  #hash: string

  constructor(dom: JSDOM) {
    this.#dom = dom
    this.#content = dom.serialize()
    this.#hash = getHash(this.#content)
  }

  get svg() {
    return this.#dom.window.document.querySelector('svg')!
  }

  get content() {
    return this.#content
  }

  get hash() {
    return this.#hash
  }
}

const resolveFileName = (pattern: string, hash: string) => pattern.replace('[hash]', hash)

function makeSymbolId(pattern: string, filePath: string) {
  const { dir, name } = path.parse(filePath)
  const dirName = path.basename(path.resolve(CWD, dir))
  return pattern.replace('[dir]', dirName).replace('[name]', name)
}

function findSvgFiles(dir: string) {
  const files = fs.readdirSync(dir)
  let svgs: string[] = []

  for (const file of files) {
    const filePath = path.join(dir, file)
    const stat = fs.lstatSync(filePath)

    if (stat.isDirectory()) {
      svgs = svgs.concat(findSvgFiles(filePath))
    } else if (file.endsWith('.svg')) {
      svgs.push(filePath)
    }
  }

  return svgs
}

function writeSpriteToFile(dir: string, pattern: string, sprite: SvgSprite) {
  const fileName = resolveFileName(pattern, sprite.hash)
  const filePath = path.join(dir, fileName)
  const fileContent = `${sprite.content}\n`

  try {
    if (fs.existsSync(filePath)) {
      const existingContent = fs.readFileSync(filePath, 'utf-8')
      if (existingContent === fileContent) {
        return
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, fileContent)
    console.info(`SVG sprite saved to ${filePath}`)
  } catch (error) {
    console.error(`Error writing sprite to ${filePath}`, error)
  }
}

function createWatcher(paths: string[], onChange: (path: string) => void) {
  return watch(paths, {
    ignored: /(^|[\\])\../,
    persistent: true,
    ignoreInitial: true,
    alwaysStat: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })
    .on('add', onChange)
    .on('change', onChange)
    .on('unlink', onChange)
    .on('error', (error) => console.error('Watcher error:', error))
}

export default function svgSprite({
  include,
  symbolId = DEFAULT_SYMBOL_ID,
  svgoConfig = DEFAULT_SVGO_CONFIG,
  inject,
  fileName,
  attributes,
}: PluginOptions): Plugin {
  if (!symbolId.includes('[name]')) {
    throw new Error('Option symbolId must contain [name] substring.')
  }
  if (!Object.hasOwn(svgoConfig, 'multipass')) {
    svgoConfig.multipass = true
  }
  let svgSprite: SvgSprite
  let watcher: ReturnType<typeof watch> | null = null
  let hasGeneratedSprite = false
  let resolvedConfig: ResolvedConfig | null = null
  const svgCache = new Map<string, HTMLElement>()
  const dirs = Array.isArray(include) ? include : [include]

  async function generateSvgSprite() {
    const dom = new JSDOM('<svg></svg>', { contentType: 'text/xml' })
    const { document } = dom.window
    const sprite = document.querySelector('svg')!
    const files: string[] = []

    // Maintain the order of files in the output sprite to ensure consistent hashing.
    for (const dir of dirs) {
      for (const file of findSvgFiles(dir)) {
        files.push(file)
      }
    }

    await Promise.all(
      files.map(async (file) => {
        try {
          if (svgCache.has(file)) {
            return
          }
          const svgContent = await fs.promises.readFile(file, 'utf-8')
          const optimizedSvg = optimize(svgContent, svgoConfig).data
          const fragment = JSDOM.fragment(optimizedSvg)
          const svg = fragment.querySelector('svg')
          if (!svg) {
            throw new Error(`No SVG element found in ${file}`)
          }
          const symbol = document.createElement('symbol')
          for (const attr of svg.attributes) {
            symbol.setAttribute(attr.name, attr.value)
          }
          symbol.setAttribute('id', makeSymbolId(symbolId, file))
          symbol.innerHTML = svg.innerHTML
          svgCache.set(file, symbol)
        } catch (error) {
          console.error(`Error reading or processing SVG file ${file}`, error)
        }
      }),
    )

    for (const file of files) {
      sprite.appendChild(svgCache.get(file)!)
    }

    sprite.setAttribute('xmlns', SVG_NS)
    if (attributes) {
      for (const [name, value] of Object.entries(attributes)) {
        sprite.setAttribute(name, value)
      }
    }

    svgSprite = new SvgSprite(dom)
  }

  function getConfig() {
    if (resolvedConfig === null) {
      throw new Error('Unreachable.')
    }
    return resolvedConfig
  }

  return {
    name: 'vite-plugin-svg-sprite',
    enforce: 'pre',

    async configResolved(config) {
      resolvedConfig = config
      hasGeneratedSprite = false

      // Generate sprite on initial build.
      await generateSvgSprite()

      const isWatchMode = config.command === 'build' && !!config.build.watch

      // Set up watcher only in watch mode.
      if (!watcher && isWatchMode) {
        const absolutePaths = dirs.map((dir) =>
          path.isAbsolute(dir) ? dir : path.resolve(CWD, dir),
        )

        watcher = createWatcher(absolutePaths, async (filePath) => {
          if (!filePath.endsWith('.svg')) {
            return
          }
          try {
            svgCache.clear()
            await generateSvgSprite()

            if (filePath) {
              const { outDir, assetsDir } = config.build
              writeSpriteToFile(path.join(outDir, assetsDir), filePath, svgSprite)
            }

            // Touch entry file to trigger rebuild.
            try {
              // Get entry file from Vite config.
              let entry: string | undefined

              if (typeof config.build.lib === 'object') {
                if (typeof config.build.lib.entry === 'string') {
                  entry = config.build.lib.entry
                } else if (Array.isArray(config.build.lib.entry)) {
                  entry = config.build.lib.entry[0]
                }
              }

              if (entry) {
                const entryFile = path.resolve(CWD, entry)
                if (fs.existsSync(entryFile)) {
                  fs.utimesSync(entryFile, new Date(), new Date())
                  return
                }
              }

              console.warn('Entry file not found - skipping rebuild trigger')
            } catch (error) {
              console.error('Failed to trigger rebuild:', error)
            }
          } catch (error) {
            console.error('Error handling SVG change:', error)
          }
        })
      }
    },

    configureServer(server) {
      // Watch SVG files in development.
      for (const dir of dirs) {
        const absolutePath = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
        server.watcher.add(path.join(absolutePath, '**/*.svg'))
      }

      let debounceTimer: NodeJS.Timeout
      const handleDevChange = async () => {
        try {
          svgCache.clear()
          await generateSvgSprite()

          // Invalidate virtual module and reload.
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID)
          if (mod) {
            server.moduleGraph.invalidateModule(mod)
            server.ws.send({ type: 'full-reload' })
          }
        } catch (error) {
          console.error('Error handling SVG change:', error)
        }
      }

      // Handle SVG changes with debouncing.
      server.watcher.on('all', (event, file) => {
        if (file.endsWith('.svg')) {
          console.info(`SVG ${event}`)
          clearTimeout(debounceTimer)
          debounceTimer = setTimeout(handleDevChange, 100)
        }
      })

      // Serve sprite file in development.
      if (typeof fileName === 'string') {
        server.middlewares.use((req, res, next) => {
          const { assetsDir } = getConfig().build
          const name = resolveFileName(fileName, svgSprite.hash)
          const filePath = path.join(assetsDir, name)
          const url = filePath.startsWith('/') ? filePath : `/${filePath}`
          if (req.url === url) {
            res.setHeader('content-type', 'image/svg+xml')
            res.end(svgSprite.content)
          } else {
            next()
          }
        })
      }
    },

    closeBundle() {
      // Only close watcher if we're not in watch mode.
      if (watcher && !this.meta.watchMode) {
        watcher.close()
        watcher = null
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        let code = `
          export const sprite = ${JSON.stringify(svgSprite.content)}
        `
        if (typeof fileName === 'string') {
          const { assetsDir } = getConfig().build
          const name = resolveFileName(fileName, svgSprite.hash)
          const filePath = path.join(assetsDir, name)
          const url = filePath.startsWith('/') ? filePath : `/${filePath}`
          code += `
            export const url = ${JSON.stringify(url)}
          `
        }
        return code
      }
    },

    transformIndexHtml(html: string) {
      if (inject) {
        const dom = new JSDOM(html)
        const { document } = dom.window
        switch (inject) {
          case 'body-first': {
            document.querySelector('body')?.prepend(svgSprite.svg)
            break
          }
          case 'body-last': {
            document.querySelector('body')?.appendChild(svgSprite.svg)
            break
          }
          default: {
            throw new Error(`Unknown inject option value: ${inject}`)
          }
        }
        return dom.serialize()
      }
      return html
    },

    generateBundle() {
      // Write sprite file during bundle generation.
      if (fileName && !hasGeneratedSprite) {
        const { outDir, assetsDir } = getConfig().build
        writeSpriteToFile(path.join(outDir, assetsDir), fileName, svgSprite)
        // Mark that we've generated the sprite to prevent multiple writes.
        hasGeneratedSprite = true
      }
    },
  }
}
