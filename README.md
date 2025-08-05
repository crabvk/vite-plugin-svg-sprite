# SVG sprite plugin for Vite.

Vite plugin for generating SVG sprite from SVG files.

Based on [@pivanov/vite-plugin-svg-sprite](https://github.com/pivanov/vite-plugin-svg-sprite).

## Improvements

* Use [jsdom](https://github.com/jsdom/jsdom) instead of [cheerio](https://github.com/cheeriojs/cheerio) for SVG parsing.
* Add SVG sprite contents hash to output file name.
* Serve SVG sprite file in development.
* Allows for any SVG tag attributes via the `attributes` plugin option.
* Output dynamic type for better DX.

## Install

```shell
npm i -D @crabvk/vite-plugin-svg-sprite
```

## Usage

Add plugin to your *vite.config.ts*:

```typescript
import svgSprite from '@crabvk/vite-plugin-svg-sprite'

export default {
  plugins: [
    svgSprite({
      // Can be a string or an object (required).
      include: {
        regular: 'src/icons/fontawesome/regular',
        solid: 'src/icons/fontawesome/solid',
      },
      // Add resulting SVG sprite to the index.html (optional).
      inject: 'body-last',
      // Override default SVGO config. See src/index.ts for the default (optional).
      svgoConfig: {},
      // Output SVG sprite into dist/assets directory (optional).
      fileName: 'sprite-[hash].svg',
      // Attributes added to the resulting SVG sprite (optional).
      attributes: {
        id: 'svg-sprite',
        style: 'position:absolute;width:0;height:0;'
      },
      // Directory relative to your project root
      // where to output dynamic type file (see React example below) (optional).
      typesDir: 'types',
    }),
  ],
}
```

To use 'virtual:svg-sprite' module add to your *src/vite-env.d.ts*:

```typescript
/// <reference types="@crabvk/vite-plugin-svg-sprite/client" />
```

To use dynamic type add to your *tsconfig.json* `"include"` option:

```json
{
  "include": ["src", "types/vite-plugin-svg-sprite.d.ts"]
}
```

Use in your React project:

```tsx
// Virtual Vite module exporting `sprite` and `url` variables.
import { url } from 'virtual:svg-sprite'
// Dynamic type defining scopes and symbol names for each scope.
import type { SymbolId } from '@crabvk/vite-plugin-svg-sprite/types'

interface IconProps<T extends keyof SymbolId> {
  variant: T
  name: SymbolId[T]
}

export default function Icon<T extends keyof SymbolId>({ variant, name }: IconProps<T>) {
  return (
    <svg>
      <use href={`${url}#${variant}-${name}`} />
    </svg>
  )
}
```
