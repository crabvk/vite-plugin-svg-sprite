# SVG sprite plugin for Vite.

Vite plugin for generating SVG sprite from SVG files.

Based on [@pivanov/vite-plugin-svg-sprite](https://github.com/pivanov/vite-plugin-svg-sprite).

## Improvemens

* Use [jsdom](https://github.com/jsdom/jsdom) instead of [cheerio](https://github.com/cheeriojs/cheerio) for SVG parsing.
* Add SVG sprite contents hash to output file name.
* Serve sprite file in development.
* Allow for any SVG tag attributes via the `attributes` plugin option.

## Install

```shell
npm i -D @crabvk/vite-plugin-svg-sprite
```

## Usage

Add the plugin to your *vite.config.ts*:

```shell
import svgSprite from '@crabvk/vite-plugin-svg-sprite'

export default {
  plugins: [
    svgSprite({
      include: 'src/icons', // Or array of paths.
      fileName: 'sprite-[hash].svg', // Outputs SVG sprite into dist/assets directory.
      // Optional attributes added to the resulting SVG sprite.
      attributes: {
        id: 'svg-sprite',
        style: 'position:absolute;width:0;height:0;'
      },
    }),
  ],
}
```

Add to your *src/vite-env.d.ts*:

```typescript
/// <reference types="@crabvk/vite-plugin-svg-sprite/client" />
```

Use in your project:

```typescript
import { sprite, url } from 'virtual:svg-sprite'
// `sprite` is the string containing resulting SVG sprite.
// `url` is the URl to SVG sprite file.
```
