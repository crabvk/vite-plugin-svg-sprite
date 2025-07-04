import fs from 'node:fs'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { watch } from 'chokidar'
import { optimize, type Config as SvgoConfig } from 'svgo'
import type { Plugin, ResolvedConfig } from 'vite'

interface PluginOptions {
  include: string | string[]
  symbolId?: string
  svgDomId?: string
  inject?: 'body-last' | 'body-first'
  svgoConfig?: SvgoConfig
  filePath?: string
}

const CWD = process.cwd()
const VIRTUAL_MODULE_ID = 'virtual:svg-sprite'
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`
const DEFAULT_SYMBOL_ID = '[dir]-[name]'
const STYLE = 'position:absolute;width:0;height:0;'
const DEFAULT_SVGO_CONFIG: SvgoConfig = {
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: {
            minify: false,
          },
          mergePaths: false,
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

function writeSpriteToFile(assetsDir: string, filePath: string, spriteContent: string) {
  const fullPath = path.join(assetsDir, filePath)
  const finalSpriteContent = `${spriteContent.trim()}\n`

  try {
    if (fs.existsSync(fullPath)) {
      const existingContent = fs.readFileSync(fullPath, 'utf-8')
      if (existingContent === finalSpriteContent) {
        return
      }
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, finalSpriteContent)
    console.info(`SVG sprite saved in ${assetsDir}`)
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
  svgDomId = 'svg-sprite',
  svgoConfig = DEFAULT_SVGO_CONFIG,
  inject,
  filePath: fileName,
}: PluginOptions): Plugin {
  if (!symbolId.includes('[name]')) {
    throw new Error('Option symbolId must contain [name] substring.')
  }

  let spriteContent = ''
  const svgCache = new Map<string, string>()
  let collectedDefs = ''
  let watcher: ReturnType<typeof watch> | null = null
  let hasGeneratedSprite = false
  let resolvedConfig: ResolvedConfig | null = null

  async function generateSvgSprite() {
    let svgSymbols = ''

    await Promise.all(
      [include].flat().map(async (dir) => {
        const svgFiles = findSvgFiles(dir)
        await Promise.all(
          svgFiles.map(async (filePath) => {
            try {
              const svgContent = await fs.promises.readFile(filePath, 'utf-8')
              if (!svgCache.has(filePath)) {
                const optimizedSvg = optimize(svgContent, {
                  ...svgoConfig,
                  multipass: true,
                }).data

                const $ = cheerio.load(optimizedSvg, { xmlMode: true })
                const $svg = $('svg')
                const viewBox = $svg.attr('viewBox') || '0 0 24 24'

                // Create symbol with all original SVG attributes except width and height.
                const $symbol = $('<symbol></symbol>')
                  .attr('id', makeSymbolId(symbolId, filePath))
                  .attr('viewBox', viewBox)

                // Copy all attributes from SVG except width and height.
                const attrs = $svg[0].attribs
                for (const [key, value] of Object.entries(attrs)) {
                  if (key !== 'width' && key !== 'height') {
                    $symbol.attr(key, value)
                  }
                }

                $symbol.append($svg.children())

                const $defs = $svg.find('defs')
                if ($defs.length > 0) {
                  collectedDefs += $defs.html()
                }

                svgCache.set(filePath, $.html($symbol))
              }

              svgSymbols += svgCache.get(filePath)
            } catch (error) {
              console.error(`Error reading or processing SVG file: ${filePath}`, error)
            }
          }),
        )
      }),
    )

    if (svgSymbols.length > 0) {
      const defsContent = collectedDefs ? `<defs>${collectedDefs}</defs>` : ''
      spriteContent = `<svg xmlns="http://www.w3.org/2000/svg" style="${STYLE}" id="${svgDomId}">${defsContent}${svgSymbols}</svg>`
    } else {
      console.warn('No SVG symbols were generated.')
      spriteContent = `<svg xmlns="http://www.w3.org/2000/svg" style="${STYLE}" id="${svgDomId}"></svg>`
    }

    return spriteContent
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
          if (!filePath.endsWith('.svg')) return
          try {
            svgCache.clear()
            collectedDefs = ''
            await generateSvgSprite()

            if (fileName) {
              const { assetsDir } = config.build
              writeSpriteToFile(assetsDir, fileName, spriteContent)
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
          collectedDefs = ''
          await generateSvgSprite()

          // Invalidate virtual module and reload.
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID)
          if (mod) {
            server.moduleGraph.invalidateModule(mod)
            server.ws.send({ type: 'full-reload' })
          }
        } catch (error) {
          console.error('❌ Error handling SVG change:', error)
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
          const sprite = ${JSON.stringify(spriteContent)}
          export default sprite
        `
      }
    },

    transformIndexHtml(html: string) {
      if (inject) {
        const $ = cheerio.load(html)
        switch (inject) {
          case 'body-first':
            $('body').prepend(spriteContent)
            break
          default:
            $('body').append(spriteContent)
        }
        return $.html()
      }
      return html
    },

    generateBundle() {
      if (resolvedConfig === null) {
        throw new Error('Unreachable.')
      }
      // Write sprite file during bundle generation.
      if (fileName && !hasGeneratedSprite) {
        const { assetsDir } = resolvedConfig.build
        writeSpriteToFile(assetsDir, fileName, spriteContent)
        // Mark that we've generated the sprite to prevent multiple writes.
        hasGeneratedSprite = true
      }
    },
  }
}
