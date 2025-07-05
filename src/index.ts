import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { watch } from 'chokidar'
import { optimize, type Config as SvgoConfig } from 'svgo'
import type { Plugin, ResolvedConfig } from 'vite'

interface PluginOptions {
  include: string | string[]
  symbolId?: string
  inject?: 'body-last' | 'body-first'
  svgoConfig?: SvgoConfig
  filePath?: string
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

function makeSymbolId(template: string, filePath: string) {
  const { dir, name } = path.parse(filePath)
  const dirName = path.basename(path.resolve(CWD, dir))
  return template.replace('[dir]', dirName).replace('[name]', name)
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

function writeSpriteToFile(dir: string, filePath: string, sprite: JSDOM) {
  const fullPath = path.join(dir, filePath)
  const spriteContent = `${sprite.serialize()}\n`

  try {
    if (fs.existsSync(fullPath)) {
      const existingContent = fs.readFileSync(fullPath, 'utf-8')
      if (existingContent === spriteContent) {
        return
      }
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, spriteContent)
    console.info(`SVG sprite saved in ${fullPath}`)
  } catch (error) {
    console.error(`Error writing sprite file: ${fullPath}`, error)
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
  filePath: fileName,
  attributes,
}: PluginOptions): Plugin {
  if (!symbolId.includes('[name]')) {
    throw new Error('Option symbolId must contain [name] substring.')
  }
  if (!Object.hasOwn(svgoConfig, 'multipass')) {
    svgoConfig.multipass = true
  }
  let spriteDom: JSDOM
  const svgCache = new Map<string, HTMLElement>()
  let watcher: ReturnType<typeof watch> | null = null
  let hasGeneratedSprite = false
  let resolvedConfig: ResolvedConfig | null = null

  async function generateSvgSprite() {
    const dom = new JSDOM('<svg></svg>', { contentType: 'text/xml' })
    const { document } = dom.window
    const sprite = document.querySelector('svg')!

    await Promise.all(
      [include].flat().map(async (dir) => {
        const svgFiles = findSvgFiles(dir)
        await Promise.all(
          svgFiles.map(async (filePath) => {
            try {
              if (!svgCache.has(filePath)) {
                const svgContent = await fs.promises.readFile(filePath, 'utf-8')
                const optimizedSvg = optimize(svgContent, svgoConfig).data

                const fragment = JSDOM.fragment(optimizedSvg)
                const svg = fragment.querySelector('svg')
                if (!svg) {
                  throw new Error(`No SVG element found in ${filePath}`)
                }

                const symbol = document.createElement('symbol')
                for (const attr of svg.attributes) {
                  symbol.setAttribute(attr.name, attr.value)
                }
                symbol.setAttribute('id', makeSymbolId(symbolId, filePath))
                symbol.innerHTML = svg.innerHTML

                svgCache.set(filePath, symbol)
              }

              sprite.appendChild(svgCache.get(filePath)!)
            } catch (error) {
              console.error(`Error reading or processing SVG file ${filePath}`, error)
            }
          }),
        )
      }),
    )

    sprite.setAttribute('xmlns', SVG_NS)
    if (attributes) {
      for (const [name, value] of Object.entries(attributes)) {
        sprite.setAttribute(name, value)
      }
    }

    spriteDom = dom
    return dom
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
        const absolutePaths = [include]
          .flat()
          .map((dir) => (path.isAbsolute(dir) ? dir : path.resolve(CWD, dir)))

        watcher = createWatcher(absolutePaths, async (filePath) => {
          if (!filePath.endsWith('.svg')) {
            return
          }
          try {
            svgCache.clear()
            await generateSvgSprite()

            if (fileName) {
              const { outDir, assetsDir } = config.build
              writeSpriteToFile(path.join(outDir, assetsDir), fileName, spriteDom)
            }

            // Touch entry file to trigger rebuild.
            try {
              // Get entry file from Vite config.
              let entry: string | undefined

              if (config.build.lib && typeof config.build.lib === 'object') {
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
      // Watch SVG files in dev mode.
      for (const dir of include) {
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
        return `
          const sprite = ${JSON.stringify(spriteDom.serialize())}
          export default sprite
        `
      }
    },

    transformIndexHtml(html: string) {
      if (inject) {
        const dom = new JSDOM(html)
        const { document } = dom.window
        const svg = spriteDom.window.document.querySelector('svg')!
        switch (inject) {
          case 'body-first': {
            document.querySelector('body')?.prepend(svg)
            break
          }
          case 'body-last': {
            document.querySelector('body')?.appendChild(svg)
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
      if (resolvedConfig === null) {
        throw new Error('Unreachable.')
      }
      // Write sprite file during bundle generation.
      if (fileName && !hasGeneratedSprite) {
        const { outDir, assetsDir } = resolvedConfig.build
        writeSpriteToFile(path.join(outDir, assetsDir), fileName, spriteDom)
        // Mark that we've generated the sprite to prevent multiple writes.
        hasGeneratedSprite = true
      }
    },
  }
}
